/**
 * Whether a caller may make an Oxy file a merchant's avatar — the ONE check
 * every avatar write goes through (`registerMerchant` and `applyMerchantPatch`
 * in `routes/merchants.ts`, which both the service routes and the dashboard
 * routes call).
 *
 * ## Why this exists
 *
 * `avatarFileId` was accepted as any string and rendered to every payer on the
 * checkout page through `oxy.assets.publicUrl`. Oxy file ids are not secrets —
 * they sit in public URLs — so any merchant could brand their checkout with
 * ANYONE's public picture: another company's logo, a person's profile photo.
 * Oxy Files now records who owns a file and who uses it (ADR 0043), and this
 * is where Peable asks.
 *
 * ## The rule
 *
 * The file must be `active` and owned by one of:
 *
 *  - the merchant's own Oxy application (a third-party application may own
 *    files, ADR 0043 D3);
 *  - an account the caller IS or ACTS FOR: the application's owner account
 *    (whose member the dashboard caller was verified to be, and which a
 *    service token names as its billing principal), the signed-in dashboard
 *    user, or the user a service token acts as under a delegation grant.
 *
 * Then Peable registers its reference to the file. Oxy refuses a reference to
 * a private file nobody attached to Peable — and a private file is one no payer
 * could load — so that refusal is an answer too.
 *
 * FAIL CLOSED. If Oxy cannot be asked, or answers without the owner (it reveals
 * owners only to Oxy's own `internal`-tier applications), the avatar is
 * refused with a 503: an unverifiable file is not accepted on trust.
 */
import { ServiceAssetMetadataError } from '@oxy.so/core';
import type { OxyFilesClient } from './client';

/** Who is setting the avatar, as the route authenticated them. */
export interface AvatarActor {
  /** The Oxy application the merchant is registered for. */
  readonly applicationId: string;
  /** Every Oxy account the caller is or acts for. Empty strings are ignored. */
  readonly accountIds: readonly (string | null | undefined)[];
}

export type AvatarAcceptance =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 422 | 503; readonly message: string };

const NOT_YOURS =
  'avatarFileId must name an active Oxy file owned by you, by this application, or by the account that owns it';
const NOT_DISPLAYABLE =
  'avatarFileId must be a public or unlisted file: Peable shows it to every payer';
const UNVERIFIABLE = 'the owner of avatarFileId cannot be verified right now; try again';

/**
 * Verify `fileId` for `actor` and register Peable's use of it by the merchant
 * whose public id is `merchantPublicId`.
 *
 * The reference is registered BEFORE the merchant row is written, because the
 * refusal decides the response. If the write then fails, the caller queues a
 * sync of the pair (`enqueueReferenceSync`), which finds the file unused and
 * removes the reference; the nightly reconciliation removes any a crash left.
 */
export async function acceptMerchantAvatar(
  files: OxyFilesClient,
  fileId: string,
  merchantPublicId: string,
  actor: AvatarActor,
): Promise<AvatarAcceptance> {
  let metadata: Awaited<ReturnType<OxyFilesClient['metadataByIds']>>;
  try {
    metadata = await files.metadataByIds([fileId]);
  } catch (error) {
    warn(`ownership lookup failed: ${describe(error)}`);
    return { ok: false, status: 503, message: UNVERIFIABLE };
  }

  const file = metadata.find((entry) => entry.id === fileId);
  if (file?.status !== 'active') {
    return { ok: false, status: 422, message: NOT_YOURS };
  }
  if (!('ownerUserId' in file) && file.ownerApplicationId === undefined) {
    // Oxy left the owner out: this deployment is not authenticating as an
    // `internal`-tier application. A configuration fault, not the caller's —
    // and never a reason to accept.
    warn('Oxy did not reveal the owner of a file; is Peable authenticating as itself?');
    return { ok: false, status: 503, message: UNVERIFIABLE };
  }

  const accounts = new Set(actor.accountIds.filter((id): id is string => Boolean(id)));
  const owned =
    file.ownerApplicationId === actor.applicationId ||
    (typeof file.ownerUserId === 'string' && accounts.has(file.ownerUserId));
  if (!owned) return { ok: false, status: 422, message: NOT_YOURS };

  let result: string | undefined;
  try {
    const [answer] = await files.addReferences([
      { fileId, entityType: 'merchant_avatar', entityId: merchantPublicId },
    ]);
    result = answer?.result;
  } catch (error) {
    warn(`reference registration failed: ${describe(error)}`);
    return { ok: false, status: 503, message: UNVERIFIABLE };
  }
  if (result === 'created' || result === 'exists') return { ok: true };
  return { ok: false, status: 422, message: NOT_DISPLAYABLE };
}

function describe(error: unknown): string {
  if (error instanceof ServiceAssetMetadataError) return `HTTP ${error.statuses.join(',') || '?'}`;
  return error instanceof Error ? error.message : String(error);
}

function warn(message: string): void {
  process.emitWarning(`Peable merchant avatar: ${message}`);
}
