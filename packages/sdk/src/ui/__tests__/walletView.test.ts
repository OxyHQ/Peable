import { describe, expect, it } from 'bun:test';
import { walletCanAuthorize, walletObservationState } from '../walletView';
describe('wallet observations', () => {
  it('shows a public balance independently of signing capability', () => {
    const wallet = { state: 'ready' as const, balanceLabel: '42 FAIR', canPay: false };
    expect(walletObservationState(wallet)).toBe('ready');
    expect(walletCanAuthorize(wallet)).toBe(false);
  });
  it('never invents a zero when the descriptor or observation is absent', () => {
    expect(walletObservationState({ state: 'unavailable' })).toBe('unavailable');
    expect(walletObservationState({ state: 'ready' })).toBe('unavailable');
    expect(walletCanAuthorize({ state: 'loading', canPay: true, onSelect() {} })).toBe(false);
  });
  it('requires both observed readiness and supplied authorization', () => {
    expect(walletCanAuthorize({ state: 'ready', balanceLabel: '25 FAIR', canPay: true })).toBe(
      false,
    );
    expect(
      walletCanAuthorize({ state: 'ready', balanceLabel: '25 FAIR', canPay: true, onSelect() {} }),
    ).toBe(true);
  });
});
