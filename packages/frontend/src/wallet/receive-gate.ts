/**
 * Whether the open wallet may show anything to pay into — one answer for
 * every surface that shows a receive address (security review round 6, R6-1,
 * R6-4; Peable ADR 0002, amended for round 6): the Receive sheet (QR,
 * `@username`, the address list) and the Settings header, which used to show
 * the address without asking.
 *
 * - An identity wallet: only once the gateway confirmed, since the wallet
 *   opened, that its key is the account's `#key-1` (R5-1, R5-7); a mismatch
 *   says so.
 * - A wallet carried over from the keychain group every Oxy app shares
 *   (`storage/keychain-groups.ts`): only once the person confirmed it is
 *   theirs — another Oxy app could have planted it there (R6-4).
 * - Any other wallet (created or imported here): open.
 */
import { isIdentityWalletId } from './identity-wallet';

export type ReceiveGate =
  | { readonly kind: 'open' }
  /** An identity wallet whose key the gateway has not confirmed yet. */
  | { readonly kind: 'unconfirmed' }
  /** An identity wallet whose key is not the account's `#key-1`. */
  | { readonly kind: 'mismatch' }
  /** A wallet adopted from the shared keychain group, not yet confirmed by the person. */
  | { readonly kind: 'adopted' };

export interface ReceiveGateInput {
  readonly activeWalletId: string | null;
  readonly identityReceiveConfirmed: boolean;
  readonly socialReceiveKeyMismatch: boolean;
  readonly adoptedWalletUnconfirmed: boolean;
}

export function receiveGate(state: ReceiveGateInput): ReceiveGate {
  if (state.activeWalletId !== null && isIdentityWalletId(state.activeWalletId)) {
    if (state.socialReceiveKeyMismatch) return { kind: 'mismatch' };
    return state.identityReceiveConfirmed ? { kind: 'open' } : { kind: 'unconfirmed' };
  }
  return state.adoptedWalletUnconfirmed ? { kind: 'adopted' } : { kind: 'open' };
}
