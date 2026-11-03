/**
 * Whether a caller may make an Oxy file THEIRS inside Peable — the ONE
 * ownership check. Two writes reach it: a merchant's avatar
 * (`registerMerchant` and `applyMerchantPatch` in `routes/merchants.ts`, which
 * both the service and the dashboard routes call), and an Orbit File imported
 * from Oxy (`POST /v1/files` with `oxy_file`, `services/files.ts`). Bytes
 * UPLOADED as a File need no check: Peable stores them as its own application
 * file, so ownership is Peable's by construction.
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
 * owners only to verified first-party workload authority), the avatar is
 * refused with a 503: an unverifiable file is not accepted on trust.
 */
import { type ServiceAssetMetadata, ServiceAssetMetadataError } from '@oxy.so/core';
import type { OxyFileEntityType } from '../../db/schema/valueSets';
import type { OxyFilesClient } from './client';

/** Who is claiming the file, as the route authenticated them. */
export interface FileActor {
  /** The Oxy application the merchant is registered for. */
  readonly applicationId: string;
  /** Every Oxy account the caller is or acts for. Empty strings are ignored. */
  readonly accountIds: readonly (string | null | undefined)[];
}

export type FileAcceptance =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 400 | 503; readonly message: string };

/** How a refusal names the field the caller sent. */
const notYours = (param: string) =>
  `${param} must name an active Oxy file owned by you, by this application, or by the account that owns it`;
const notReferenceable = (param: string) =>
  `${param} must be a public or unlisted file, or one its owner attached to Peable`;
const unverifiable = (param: string) =>
  `the owner of ${param} cannot be verified right now; try again`;

/** The Peable use the accepted file is registered for. */
export interface FileUse {
  readonly entityType: OxyFileEntityType;
  /** The PUBLIC id of the entity (`merch_…`, `file_…`). */
  readonly entityId: string;
  /** The request field that named the file, for the refusal message. */
  readonly param: string;
}

/**
 * Verify `fileId` for `actor` and register Peable's use of it (`use`).
 *
 * The reference is registered BEFORE the row is written, because the refusal
 * decides the response. If the write then fails, the caller queues a sync of
 * the pair (`enqueueReferenceSync`), which finds the file unused and removes
 * the reference; the nightly reconciliation removes any a crash left.
 */
export async function acceptOxyFile(
  files: OxyFilesClient,
  fileId: string,
  use: FileUse,
  actor: FileActor,
): Promise<FileAcceptance & { readonly metadata?: ServiceAssetMetadata }> {
  const NOT_YOURS = notYours(use.param);
  const UNVERIFIABLE = unverifiable(use.param);
  const NOT_DISPLAYABLE = notReferenceable(use.param);
  let metadata: Awaited<ReturnType<OxyFilesClient['metadataByIds']>>;
  try {
    metadata = await files.metadataByIds([fileId]);
  } catch (error) {
    warn(`ownership lookup failed: ${describe(error)}`);
    return { ok: false, status: 503, message: UNVERIFIABLE };
  }

  const file = metadata.find((entry) => entry.id === fileId);
  if (file?.status !== 'active') {
    return { ok: false, status: 400, message: NOT_YOURS };
  }
  if (!('ownerUserId' in file) && file.ownerApplicationId === undefined) {
    // Oxy left the owner out: verified first-party workload authority is
    // unavailable. Application branding or tier cannot replace that proof,
    // and missing ownership is never a reason to accept.
    warn('Oxy did not reveal the owner of a file; is Peable authenticating as itself?');
    return { ok: false, status: 503, message: UNVERIFIABLE };
  }

  const accounts = new Set(actor.accountIds.filter((id): id is string => Boolean(id)));
  const owned =
    file.ownerApplicationId === actor.applicationId ||
    (typeof file.ownerUserId === 'string' && accounts.has(file.ownerUserId));
  if (!owned) return { ok: false, status: 400, message: NOT_YOURS };

  let result: string | undefined;
  try {
    const [answer] = await files.addReferences([
      { fileId, entityType: use.entityType, entityId: use.entityId },
    ]);
    result = answer?.result;
  } catch (error) {
    warn(`reference registration failed: ${describe(error)}`);
    return { ok: false, status: 503, message: UNVERIFIABLE };
  }
  if (result === 'created' || result === 'exists') return { ok: true, metadata: file };
  return { ok: false, status: 400, message: NOT_DISPLAYABLE };
}

function describe(error: unknown): string {
  if (error instanceof ServiceAssetMetadataError) return `HTTP ${error.statuses.join(',') || '?'}`;
  return error instanceof Error ? error.message : String(error);
}

function warn(message: string): void {
  process.emitWarning(`Peable Oxy file ownership: ${message}`);
}
