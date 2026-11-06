import type { PaymentIntent } from '@peable.to/shared-types';

/**
 * One complete ADR 0019 PaymentIntent for every suite here, so a field added to
 * the contract is added once. A FairCoin intent by default; `chain` overrides
 * its `faircoin` side (txid, confirmations) without restating the address.
 */
export function intentFixture(
  overrides: Partial<PaymentIntent> = {},
  chain: Partial<NonNullable<PaymentIntent['faircoin']>> = {},
): PaymentIntent {
  const now = Math.floor(Date.now() / 1000);
  const rail = overrides.rail ?? 'faircoin';
  const amount = overrides.amount ?? '150000000';
  const address = 'TAddressExample1111111111111111111';
  const faircoin =
    rail === 'faircoin'
      ? {
          network: 'testnet' as const,
          address,
          outputs: [{ address, amount, connected_account: null }],
          txid: null,
          confirmations: 0,
          required_confirmations: 6,
          quote: null,
          recipient_key_replaced_at: null,
          ...chain,
        }
      : null;
  const status =
    overrides.status ?? (rail === 'faircoin' ? 'requires_action' : 'requires_payment_method');
  return {
    id: 'pi_live123',
    object: 'payment_intent',
    livemode: false,
    status,
    rail,
    payment_method_types: [rail],
    payment_method_configuration_details: null,
    amount,
    amount_capturable: '0',
    amount_received: status === 'succeeded' ? amount : '0',
    amount_refunded: '0',
    currency: rail === 'faircoin' ? 'FAIR' : 'EUR',
    capture_method: 'automatic',
    setup_future_usage: null,
    customer: null,
    payment_method: null,
    latest_charge: null,
    next_action:
      status === 'requires_action' && faircoin !== null
        ? {
            type: 'faircoin_payment',
            faircoin_payment: {
              address: faircoin.address,
              network: faircoin.network,
              amount,
              currency: 'FAIR',
              uri: faircoin.address ? `faircoin:${faircoin.address}` : null,
              outputs: faircoin.outputs.map((output) => ({
                address: output.address,
                amount: output.amount,
              })),
            },
          }
        : null,
    last_payment_error: null,
    cancellation_reason: null,
    canceled_at: status === 'canceled' ? now : null,
    description: null,
    receipt_email: null,
    statement_descriptor_suffix: null,
    shipping: null,
    faircoin,
    merchant_id: 'merch_1',
    connected_account: null,
    application_fee_amount: null,
    transfer_data: null,
    on_behalf_of: null,
    client_secret: 'pi_live123_secret',
    metadata: {},
    expires_at: now + 60,
    can_expire: ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(
      status,
    ),
    created: now,
    updated_at: now,
    ...overrides,
  };
}
