import { expect, it } from 'bun:test';
import { providerAcceptedConfirmation } from '../providerConfirmation';
it('accepts only an explicit completed authorization or asynchronous provider processing', () => {
  for (const status of ['succeeded', 'processing', 'requires_capture'])
    expect(providerAcceptedConfirmation({ paymentIntent: { status } })).toBe(true);
});
it('never accepts missing, canceled, incomplete or still-authenticating provider results', () => {
  for (const status of [
    'requires_action',
    'requires_payment_method',
    'requires_confirmation',
    'canceled',
    'unknown',
  ])
    expect(providerAcceptedConfirmation({ paymentIntent: { status } })).toBe(false);
  expect(providerAcceptedConfirmation({})).toBe(false);
  expect(
    providerAcceptedConfirmation({
      error: { message: 'Declined' },
      paymentIntent: { status: 'succeeded' },
    }),
  ).toBe(false);
});
