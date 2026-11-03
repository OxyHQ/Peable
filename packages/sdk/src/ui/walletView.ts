/** A public-wallet observation does not imply possession of signing capability. */
export interface WalletObservation {
  state: 'ready' | 'loading' | 'unavailable' | 'error';
  balanceLabel?: string;
}

export function walletObservationState(wallet: WalletObservation): WalletObservation['state'] {
  return wallet.state === 'ready' && !wallet.balanceLabel?.trim() ? 'unavailable' : wallet.state;
}

export function walletCanAuthorize(
  wallet: WalletObservation & { canPay: boolean; onSelect?: () => void },
): boolean {
  return (
    walletObservationState(wallet) === 'ready' &&
    wallet.canPay &&
    typeof wallet.onSelect === 'function'
  );
}
