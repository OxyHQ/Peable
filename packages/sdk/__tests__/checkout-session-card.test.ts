import { describe, expect, it, mock } from 'bun:test';
import type {
  ProviderElement,
  ProviderSdk,
  ProviderCheckoutSession,
} from '../src/browser/providerJs';
import {
  matchingCheckoutSessionAction,
  prepareCheckoutSessionCard,
  type CheckoutSessionAction,
} from '../src/ui/preparedCheckoutSession';

const action: CheckoutSessionAction = {
  kind: 'checkout_session',
  provider: 'stripe',
  session_id: 'cs_test_owned',
  client_secret: 'opaque-session-capability',
  publishable_key: 'pk_test_owned',
  amount_minor_units: '599',
  currency: 'USD',
};
const messages = { failed: 'failed', incomplete: 'incomplete', busy: 'busy', closed: 'closed' };
function fixture(email?: string) {
  let current = true;
  let session: ProviderCheckoutSession = {
    id: action.session_id,
    livemode: false,
    currency: 'usd',
    minorUnitsAmountDivisor: 100,
    canConfirm: true,
    total: { total: { minorUnitsAmount: 599 } },
    status: { type: 'open' },
  };
  const confirm = mock(async () => ({
    type: 'success' as const,
    session: { ...session, status: { type: 'complete' as const, paymentStatus: 'paid' } },
  }));
  const tokenize = mock(async () => ({
    paymentMethod: { id: 'pm_owned', card: { brand: 'visa', last4: '4242' } },
  }));
  const loadActions = mock(async () => ({
    type: 'success' as const,
    actions: { getSession: () => session, confirm },
  }));
  const provider: ProviderSdk = {
    elements: () => {
      throw new Error('unused');
    },
    confirmPayment: async () => {
      throw new Error('unused');
    },
    createPaymentMethod: tokenize,
    initCheckoutElementsSdk: () => ({ loadActions }),
  };
  const card: ProviderElement = { mount() {}, unmount() {}, destroy() {} };
  const prepare = () =>
    prepareCheckoutSessionCard({
      provider,
      card,
      billing: { country: 'US', postcode: '19802', email },
      action,
      returnUrl: 'https://mention.earth/plus',
      messages,
      isCurrent: () => current,
    });
  return {
    prepare,
    confirm,
    tokenize,
    loadActions,
    provider,
    expire: () => {
      current = false;
    },
    change: (next: Partial<ProviderCheckoutSession>) => {
      session = { ...session, ...next };
    },
  };
}
describe('Checkout Session secure card authority', () => {
  it('only tokenizes on preparation and sends opaque method on explicit confirmation', async () => {
    const f = fixture();
    const result = await f.prepare();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(result.prepared).toBe(true);
    if (!result.prepared) throw new Error('Expected preparation');
    expect(result.authorization.card).toEqual({ brand: 'visa', last4: '4242' });
    expect(await result.authorization.confirm()).toEqual({ accepted: true });
    expect(f.confirm).toHaveBeenCalledWith({
      paymentMethod: 'pm_owned',
      redirect: 'if_required',
    });
    await result.authorization.confirm();
    expect(f.confirm).toHaveBeenCalledTimes(1);
  });
  it.each([
    { id: 'cs_test_other' },
    { livemode: true },
    { currency: 'eur' },
    { total: { total: { minorUnitsAmount: 600 } } },
    { minorUnitsAmountDivisor: 1 },
    { status: { type: 'expired' as const } },
  ])('rejects altered session before tokenization: %j', async (change) => {
    const f = fixture();
    f.change(change);
    expect((await f.prepare()).prepared).toBe(false);
    expect(f.tokenize).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it('revalidates quote on Pay and never confirms a changed total', async () => {
    const f = fixture();
    const result = await f.prepare();
    if (!result.prepared) throw new Error('Expected preparation');
    f.change({ total: { total: { minorUnitsAmount: 999 } } });
    expect(await result.authorization.confirm()).toEqual({ accepted: false, error: 'failed' });
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it('disposal and account change invalidate prepared authority', async () => {
    for (const reason of ['dispose', 'account']) {
      const f = fixture();
      const result = await f.prepare();
      if (!result.prepared) throw new Error('Expected preparation');
      if (reason === 'dispose') result.authorization.dispose();
      else f.expire();
      expect(await result.authorization.confirm()).toEqual({ accepted: false, error: 'closed' });
      expect(f.confirm).not.toHaveBeenCalled();
    }
  });
  it('ignores late action loading after close', async () => {
    const f = fixture();
    f.loadActions.mockImplementationOnce(async () => {
      f.expire();
      return {
        type: 'success',
        actions: {
          getSession: () => {
            throw new Error('must not read');
          },
          confirm: f.confirm,
        },
      };
    });
    expect(await f.prepare()).toEqual({ prepared: false, error: 'closed' });
    expect(f.tokenize).not.toHaveBeenCalled();
  });
  it('fails closed when actions cannot load or tokenization fails', async () => {
    const f = fixture();
    f.provider.initCheckoutElementsSdk = () => ({
      loadActions: async () => ({ type: 'error', error: { message: 'unavailable' } }),
    });
    expect(await f.prepare()).toEqual({ prepared: false, error: 'unavailable' });
    expect(f.tokenize).not.toHaveBeenCalled();
    const g = fixture();
    g.provider.createPaymentMethod = async () => ({ error: { message: 'declined' } });
    expect(await g.prepare()).toEqual({ prepared: false, error: 'declined' });
    expect(g.confirm).not.toHaveBeenCalled();
  });
  it('ignores a confirmation that completes after disposal', async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.confirm.mockImplementationOnce(async () => {
      await gate;
      return {
        type: 'success',
        session: {
          id: action.session_id,
          livemode: false,
          currency: 'usd',
          minorUnitsAmountDivisor: 100,
          canConfirm: false,
          total: { total: { minorUnitsAmount: 599 } },
          status: { type: 'complete', paymentStatus: 'paid' },
        },
      };
    });
    const result = await f.prepare();
    if (!result.prepared) throw new Error('Expected preparation');
    const confirming = result.authorization.confirm();
    result.authorization.dispose();
    release?.();
    expect(await confirming).toEqual({ accepted: false, error: 'closed' });
  });
  it('permits externally collected card preparation when no Checkout Element has supplied its method yet', async () => {
    const f = fixture();
    f.change({ canConfirm: false });
    const result = await f.prepare();
    if (!result.prepared) throw new Error('Expected preparation');
    expect(f.confirm).not.toHaveBeenCalled();
    expect(await result.authorization.confirm()).toEqual({ accepted: true });
  });
  it('passes only an explicitly supplied receipt email and keeps the server return URL', async () => {
    const f = fixture('buyer@example.test');
    const result = await f.prepare();
    if (!result.prepared) throw new Error('Expected preparation');
    expect(f.tokenize).toHaveBeenCalledWith(
      expect.objectContaining({
        billing_details: expect.objectContaining({ email: 'buyer@example.test' }),
      }),
    );
    await result.authorization.confirm();
    expect(f.confirm).toHaveBeenCalledWith({
      paymentMethod: 'pm_owned',
      redirect: 'if_required',
      email: 'buyer@example.test',
    });
  });
  it('rejects mismatched public key and session mode', () => {
    expect(matchingCheckoutSessionAction(action, 'pk_test_other')).toBeUndefined();
    expect(
      matchingCheckoutSessionAction(
        { ...action, publishable_key: 'pk_live_owned' },
        'pk_live_owned',
      ),
    ).toBeUndefined();
  });
});
