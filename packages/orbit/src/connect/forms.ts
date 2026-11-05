import type { ConnectedAccount, Transfer, TransferStatus } from '@peable.to/shared-types';
import type {
  CreateConnectedAccountBody,
  ReverseTransferBody,
  SellerAccountLinkBody,
} from '../api/dashboard';
import { normalizeCurrency, parseAmountInput } from '../format/money';
import type { FormResult } from '../money/forms';

/**
 * The pure half of Orbit's Connect screen: what its forms send, and how a
 * seller's state reads. A seller is a MARKETPLACE's seller (`ca_…`, role
 * seller); the merchant's own account is the Account page, never one of these.
 */

// --- Open a seller -----------------------------------------------------------

export interface SellerForm {
  /** The marketplace's own id for the seller: how it addresses them afterwards. */
  externalRef: string;
  card: boolean;
  /** ISO 3166-1 alpha-2, as typed. */
  country: string;
  businessType: 'individual' | 'company';
  faircoin: boolean;
  network: 'mainnet' | 'testnet';
  /** The seller's Oxy user id: the only person who may register their FairCoin key. */
  oxyUserId: string;
}

export const EMPTY_SELLER_FORM: SellerForm = {
  externalRef: '',
  card: true,
  country: '',
  businessType: 'company',
  faircoin: false,
  network: 'testnet',
  oxyUserId: '',
};

export type SellerFormError = 'externalRef' | 'rail' | 'country' | 'oxyUserId';

/** Mirrors the gateway's limits, so a form is refused here before it is sent. */
const MAX_EXTERNAL_REF = 255;
const MAX_OXY_USER_ID = 128;

/**
 * The `POST …/connected_accounts` body, or the first field that is wrong.
 * At least one rail; the card half needs a country and a business type; the
 * FairCoin half names the seller's Oxy user and the chain — never a key,
 * which only the seller registers (ADR 0012).
 */
export function buildSellerBody(
  form: SellerForm,
): FormResult<CreateConnectedAccountBody, SellerFormError> {
  const externalRef = form.externalRef.trim();
  if (!externalRef || externalRef.length > MAX_EXTERNAL_REF) {
    return { ok: false, error: 'externalRef' };
  }
  if (!form.card && !form.faircoin) return { ok: false, error: 'rail' };
  const body: CreateConnectedAccountBody = { external_ref: externalRef };
  if (form.card) {
    const country = form.country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) return { ok: false, error: 'country' };
    body.country = country;
    body.business_type = form.businessType;
  }
  if (form.faircoin) {
    const oxyUserId = form.oxyUserId.trim();
    if (!oxyUserId || oxyUserId.length > MAX_OXY_USER_ID) return { ok: false, error: 'oxyUserId' };
    body.faircoin = { network: form.network, oxy_user_id: oxyUserId };
  }
  return { ok: true, body };
}

// --- Onboarding links ----------------------------------------------------------

/** Where a seller's page lives in Orbit. */
export const sellerPath = (accountId: string) => `/connect/${encodeURIComponent(accountId)}`;

/**
 * The `POST …/connected_accounts/:id/account_links` body. The link is for the
 * SELLER to open, so it is shown and copied rather than opened here; both URLs
 * bring whoever finishes back to the seller's page in Orbit.
 */
export function sellerLinkBody(
  origin: string,
  accountId: string,
  rail: SellerAccountLinkBody['rail'],
): SellerAccountLinkBody {
  const base = `${origin.replace(/\/+$/, '')}${sellerPath(accountId)}`;
  return { return_url: base, refresh_url: `${base}?refresh=1`, rail };
}

// --- What a seller's state reads as --------------------------------------------

export type SellerReadiness = 'ready' | 'pending' | 'restricted';

/**
 * One word for the list: `ready` when every rail it has can be paid,
 * `restricted` when the provider names a reason it cannot, `pending` while
 * onboarding is unfinished. Every seller needs its OWN FairCoin receiving key
 * (ADR 0021 D5): a card-only seller, or one whose key is not registered, is
 * `pending` and is paid nothing. The detail page shows the fields this is read
 * from — this is never the authority.
 */
export function sellerReadiness(account: ConnectedAccount): SellerReadiness {
  if (account.requirements.disabled_reason) return 'restricted';
  const cardReady = !account.rails.includes('card') || account.payable;
  const faircoinReady = account.faircoin?.status === 'active';
  return cardReady && faircoinReady ? 'ready' : 'pending';
}

// --- Reversing a settlement ------------------------------------------------------

/** What is left to reverse on a settlement, in its base units. */
export function reversibleAmount(transfer: Pick<Transfer, 'amount' | 'amount_reversed'>): string {
  const left = BigInt(transfer.amount) - BigInt(transfer.amount_reversed);
  return left > 0n ? left.toString() : '0';
}

/** A settlement that can still be reversed: paid, partly reversed, and something left. */
export function canReverse(transfer: Transfer): boolean {
  const open: readonly TransferStatus[] = ['paid', 'partially_reversed'];
  return open.includes(transfer.status) && reversibleAmount(transfer) !== '0';
}

export type ReversalFormError = 'amount' | 'exceeds';

/**
 * The amount part of a reversal, in the settlement's currency: positive, no
 * more decimals than the currency has, and no more than is left.
 */
export function parseReversalAmount(
  text: string,
  transfer: Pick<Transfer, 'amount' | 'amount_reversed' | 'currency'>,
): FormResult<string, ReversalFormError> {
  const amount = parseAmountInput(text, normalizeCurrency(transfer.currency));
  if (amount === null) return { ok: false, error: 'amount' };
  if (BigInt(amount) > BigInt(reversibleAmount(transfer))) return { ok: false, error: 'exceeds' };
  return { ok: true, body: amount };
}

/**
 * A reversal instruction kept until the gateway answers it. Its `external_ref`
 * IS the reversal's identity (and its `Idempotency-Key`), so a retry after a
 * lost answer — or a reload — converges on the one reversal instead of taking
 * the amount off the seller twice.
 */
export interface PendingReversal {
  transfer: string;
  body: ReverseTransferBody;
}

export function pendingReversalStorageKey(
  scope: { applicationId: string; environment: string },
  transferId: string,
): string {
  return `peable-orbit:pending-reversal:${scope.applicationId}:${scope.environment}:${transferId}`;
}

/** A new reversal's reference: Orbit's own prefix, then a random id. */
export function newReversalRef(uuid: string): string {
  return `orbit_reversal_${uuid}`;
}

/** A stored pending reversal, read defensively: anything malformed is none. */
export function parsePendingReversal(
  raw: string | null | undefined,
  transferId: string,
): PendingReversal | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingReversal> | null;
    const body = value?.body;
    if (
      value?.transfer !== transferId ||
      !body ||
      typeof body.amount !== 'string' ||
      !/^[1-9][0-9]*$/.test(body.amount) ||
      typeof body.external_ref !== 'string' ||
      !body.external_ref.startsWith('orbit_reversal_') ||
      body.external_ref.length > 255
    ) {
      return null;
    }
    return { transfer: transferId, body: { amount: body.amount, external_ref: body.external_ref } };
  } catch {
    return null;
  }
}
