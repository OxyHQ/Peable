import { expect, test } from 'bun:test';
import { prepareCardAuthorization, type CardPreparationProvider } from '../preparedCard';
import type { ProviderConfirmResult, ProviderElement } from '../../browser/providerJs';
const card: ProviderElement = { mount() {}, destroy() {}, unmount() {} };
const messages = { failed: 'failed', incomplete: 'incomplete', busy: 'busy', closed: 'closed' };
const input = {
  card,
  billing: { country: 'HK', postcode: '' },
  clientSecret: 'test-confirmation-capability',
  returnUrl: 'http://localhost:8110/plus',
  messages,
};
test('Continue tokenizes only, masked authorization survives secure field destruction and Pay charges once', async () => {
  let confirms = 0;
  let tokenizations = 0;
  let captured: unknown;
  let finish: ((value: ProviderConfirmResult) => void) | undefined;
  const provider: CardPreparationProvider = {
    async createPaymentMethod(value) {
      tokenizations++;
      captured = value;
      return { paymentMethod: { id: 'pm_test123', card: { brand: 'visa', last4: '4242' } } };
    },
    async confirmCardPayment(_secret, value) {
      confirms++;
      expect(value.payment_method).toBe('pm_test123');
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const prepared = await prepareCardAuthorization({ ...input, provider });
  expect(tokenizations).toBe(1);
  expect(confirms).toBe(0);
  expect(captured).toEqual({
    type: 'card',
    card,
    billing_details: { address: { country: 'HK', postal_code: '' } },
  });
  if (!prepared.prepared) throw new Error('Expected prepared card');
  expect(prepared.authorization.card).toEqual({ brand: 'visa', last4: '4242' });
  card.destroy();
  const pending = prepared.authorization.confirm();
  expect(await prepared.authorization.confirm()).toEqual({ accepted: false, error: 'busy' });
  if (!finish) throw new Error('Expected pending provider confirmation');
  finish({ paymentIntent: { status: 'succeeded' } });
  expect(await pending).toEqual({ accepted: true });
  expect(await prepared.authorization.confirm()).toEqual({ accepted: true });
  expect(confirms).toBe(1);
  prepared.authorization.dispose();
  expect(await prepared.authorization.confirm()).toEqual({ accepted: false, error: 'closed' });
});
test('invalid metadata never becomes an authorization and disposal prevents charging', async () => {
  let confirms = 0;
  const provider: CardPreparationProvider = {
    async createPaymentMethod() {
      return { paymentMethod: { id: 'pm_example', card: { last4: '123' } } };
    },
    async confirmCardPayment() {
      confirms++;
      return {};
    },
  };
  expect(await prepareCardAuthorization({ ...input, provider })).toEqual({
    prepared: false,
    error: 'failed',
  });
  provider.createPaymentMethod = async () => ({
    paymentMethod: { id: 'pm_example', card: { last4: '4242' } },
  });
  const prepared = await prepareCardAuthorization({ ...input, provider });
  if (!prepared.prepared) throw new Error('Expected prepared card');
  prepared.authorization.dispose();
  expect(await prepared.authorization.confirm()).toEqual({ accepted: false, error: 'closed' });
  expect(confirms).toBe(0);
});
