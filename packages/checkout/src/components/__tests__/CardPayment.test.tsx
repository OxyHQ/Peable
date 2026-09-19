/**
 * The card surface, which used to not exist.
 *
 * `CheckoutView` fell a card intent through to `StatusPanel`, with a comment
 * saying this page had no card surface yet — so a merchant could create a card
 * checkout, send the link, and the payer would arrive at a page showing them
 * the status of a payment they had no way to make.
 *
 * Two properties are worth more than the rendering here and both are asserted
 * below: the confirmation credential is fetched from the RESUME operation
 * rather than read off the intent, and a successful confirmation does NOT
 * announce success — the authoritative status arrives over the socket, from a
 * verified webhook.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { PaymentIntent } from '@peable.to/shared-types';

interface ClientActionResponse {
  object: 'client_action';
  kind: 'client_secret' | 'redirect';
  value: string;
  publishableKey?: string;
}

let clientAction: ClientActionResponse | Error = {
  object: 'client_action',
  kind: 'client_secret',
  value: 'pi_stripe_1_secret_live',
  publishableKey: 'pk_test_abc',
};
const getClientActionMock = mock(async () => {
  if (clientAction instanceof Error) throw clientAction;
  return clientAction;
});

mock.module('../../lib/intentClient', () => ({
  getPaymentIntent: mock(async () => {
    throw new Error('not used by CardPayment');
  }),
  subscribe: mock(async () => () => undefined),
  submitTx: mock(async () => {
    throw new Error('not used by CardPayment');
  }),
  getClientAction: getClientActionMock,
}));

/** What the provider's SDK was asked to do. */
const mounted: HTMLElement[] = [];
let confirmResult: { error?: { message?: string } } = {};
const confirmMock = mock(async () => confirmResult);
const destroyMock = mock(() => undefined);
let factoryKeys: string[] = [];
let elementsOptions: Record<string, unknown>[] = [];

mock.module('../../lib/providerJs', () => ({
  loadProviderSdk: async () => (key: string) => {
    factoryKeys.push(key);
    return {
      elements: (options: Record<string, unknown>) => {
        elementsOptions.push(options);
        const element = {
          mount: (node: HTMLElement) => {
            mounted.push(node);
          },
          unmount: () => undefined,
          destroy: destroyMock,
        };
        return {
          create: () => element,
          getElement: () => element,
        };
      },
      confirmPayment: confirmMock,
    };
  },
  resetProviderSdkForTesting: () => undefined,
}));

const { CardPayment, isPayableCardIntent } = await import('../CardPayment');

function cardIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_card_1',
    object: 'payment_intent',
    status: 'created',
    rail: 'card',
    amount: '4200',
    currency: 'EUR',
    network: null,
    address: null,
    merchantId: 'merch_1',
    txid: null,
    confirmations: 0,
    clientSecret: 'pi_card_1_secret',
    metadata: {},
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  clientAction = {
    object: 'client_action',
    kind: 'client_secret',
    value: 'pi_stripe_1_secret_live',
    publishableKey: 'pk_test_abc',
  };
  confirmResult = {};
  mounted.length = 0;
  factoryKeys = [];
  elementsOptions = [];
  getClientActionMock.mockClear();
  confirmMock.mockClear();
  destroyMock.mockClear();
});

afterEach(() => {
  cleanup();
});

test('fetches the credential from the resume operation and mounts the provider fields', async () => {
  const intent = cardIntent();
  render(<CardPayment intent={intent} />);

  await waitFor(() => {
    expect(mounted).toHaveLength(1);
  });

  // The credential comes from `POST …/client_action`, authorized by the
  // intent's own client secret — never from a field on the intent, which is
  // the whole reason the DTO carries none.
  expect(getClientActionMock).toHaveBeenCalledWith(intent.id, intent.clientSecret);
  // ...and the PUBLISHABLE key came with it, rather than being compiled into
  // this bundle: the checkout is deployed once and serves whichever gateway it
  // is pointed at.
  expect(factoryKeys).toEqual(['pk_test_abc']);
  expect(elementsOptions[0]?.clientSecret).toBe('pi_stripe_1_secret_live');

  const button = await screen.findByRole('button', { name: 'Pay' });
  expect((button as HTMLButtonElement).disabled).toBe(false);
});

/**
 * A confirmation the provider ACCEPTED is not a settled payment.
 *
 * 3-D Secure can still be pending, a processor can take seconds, and a redirect
 * can bring the payer back before the webhook lands. The authoritative status
 * arrives over the socket `CheckoutView` is already subscribed to; a page that
 * declared success from its own callback would tell a payer they had paid on
 * the strength of a promise their browser made.
 */
test('does not announce success when the provider accepts the confirmation', async () => {
  render(<CardPayment intent={cardIntent()} />);
  const button = await screen.findByRole('button', { name: 'Pay' });

  await act(async () => {
    button.click();
  });

  expect(confirmMock).toHaveBeenCalledTimes(1);
  // Still "confirming" — nothing on this page claims the payment succeeded.
  expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDefined();
  expect(screen.queryByText(/settled|succeeded|paid/i)).toBeNull();
});

/**
 * A decline is RECOVERABLE and the form stays. The provider returns the payment
 * to a confirmable state and the payer can try another card on the same one —
 * which is also why the gateway's state machine accepts a success after a
 * declined attempt.
 */
test('shows a decline and leaves the form usable', async () => {
  confirmResult = { error: { message: 'Your card was declined.' } };
  render(<CardPayment intent={cardIntent()} />);
  const button = await screen.findByRole('button', { name: 'Pay' });

  await act(async () => {
    button.click();
  });

  expect(screen.getByRole('alert').textContent).toBe('Your card was declined.');
  expect((screen.getByRole('button', { name: 'Pay' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

/**
 * A payment that can no longer be paid answers 409 from the resume operation.
 * Rendering an empty box would read to the payer as the merchant's site being
 * broken.
 */
test('says so when the credential cannot be obtained', async () => {
  clientAction = new Error('this payment is \'settled\' and can no longer be paid');
  render(<CardPayment intent={cardIntent()} />);

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('settled');
  expect(screen.queryByRole('button', { name: 'Pay' })).toBeNull();
});

/** The provider's iframe is destroyed on unmount — React only removes OUR node. */
test('tears down the provider element when it unmounts', async () => {
  const { unmount } = render(<CardPayment intent={cardIntent()} />);
  await waitFor(() => {
    expect(mounted).toHaveLength(1);
  });

  unmount();

  expect(destroyMock).toHaveBeenCalled();
});

/**
 * Which intents get a card form.
 *
 * `failed` is INCLUDED, and that is the retry: a declined attempt returns the
 * provider's payment to a confirmable state, and dropping the payer onto a dead
 * status panel because their first card was declined loses a sale they were
 * still trying to make.
 */
test('offers the form for every status a card payment can still be paid from', () => {
  expect(isPayableCardIntent(cardIntent({ status: 'created' }))).toBe(true);
  expect(isPayableCardIntent(cardIntent({ status: 'requires_action' }))).toBe(true);
  expect(isPayableCardIntent(cardIntent({ status: 'failed' }))).toBe(true);

  expect(isPayableCardIntent(cardIntent({ status: 'processing' }))).toBe(false);
  expect(isPayableCardIntent(cardIntent({ status: 'settled' }))).toBe(false);
  expect(isPayableCardIntent(cardIntent({ status: 'expired' }))).toBe(false);
  // ...and never the other rail, whose payer is told an address instead.
  expect(isPayableCardIntent(cardIntent({ rail: 'faircoin', status: 'created' }))).toBe(
    false,
  );
});
