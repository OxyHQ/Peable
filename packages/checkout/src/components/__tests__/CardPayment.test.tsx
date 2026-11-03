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
import { intentFixture } from '../../__tests__/intentFixture';
import type { PaymentIntent } from '@peable.to/shared-types';

interface ClientActionResponse {
  object: 'client_action';
  kind: 'client_secret' | 'redirect';
  value: string;
  publishable_key?: string;
}

let clientAction: ClientActionResponse | Error = {
  object: 'client_action',
  kind: 'client_secret',
  value: 'pi_stripe_1_secret_live',
  publishable_key: 'pk_test_abc',
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
const mounted: { type: string; node: HTMLElement }[] = [];
let confirmResult: { error?: { message?: string } } = {};
const confirmMock = mock(async () => confirmResult);
const destroyMock = mock(() => undefined);
let factoryKeys: string[] = [];
let elementsOptions: Record<string, unknown>[] = [];
/** The element events a test can fire, keyed `type:event`. */
const elementHandlers = new Map<string, (event?: Record<string, unknown>) => void>();

// The REAL card surface (`mountCardElements` and the redirect helpers) over a
// fake provider SDK: what is asserted is this page's behaviour, not a mock of it.
const realProviderJs = await import('@peable.to/sdk/checkout');
mock.module('../../lib/providerJs', () => ({
  mountCardElements: realProviderJs.mountCardElements,
  readRedirectReturn: realProviderJs.readRedirectReturn,
  withoutRedirectParams: realProviderJs.withoutRedirectParams,
  delayedProcessingNotice: realProviderJs.delayedProcessingNotice,
  loadProviderSdk: async () => (key: string) => {
    factoryKeys.push(key);
    return {
      elements: (options: Record<string, unknown>) => {
        elementsOptions.push(options);
        const byType = new Map<string, unknown>();
        return {
          create: (type: string) => {
            const element = {
              mount: (node: HTMLElement) => {
                mounted.push({ type, node });
              },
              on: (event: string, callback: (event?: Record<string, unknown>) => void) => {
                elementHandlers.set(`${type}:${event}`, callback);
              },
              unmount: () => undefined,
              destroy: destroyMock,
            };
            byType.set(type, element);
            return element;
          },
          getElement: (type: string) => byType.get(type) ?? null,
        };
      },
      confirmPayment: confirmMock,
    };
  },
  resetProviderSdkForTesting: () => undefined,
}));

const { CardPayment, isPayableCardIntent } = await import('../CardPayment');

function cardIntent(
  overrides: Partial<PaymentIntent> = {},
  chain: Partial<NonNullable<PaymentIntent['faircoin']>> = {},
): PaymentIntent {
  return intentFixture(
    {
      id: 'pi_card_1',
      rail: 'card',
      status: 'requires_payment_method',
      amount: '4200',
      client_secret: 'pi_card_1_secret',
      expires_at: Math.floor((Date.now() + 900_000) / 1000),
      ...overrides,
    },
    chain,
  );
}

beforeEach(() => {
  clientAction = {
    object: 'client_action',
    kind: 'client_secret',
    value: 'pi_stripe_1_secret_live',
    publishable_key: 'pk_test_abc',
  };
  confirmResult = {};
  mounted.length = 0;
  elementHandlers.clear();
  window.history.replaceState(null, '', '/i/pi_card_1');
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
    expect(mounted.map((entry) => entry.type)).toEqual(['expressCheckout', 'payment']);
  });

  // The credential comes from `POST …/client_action`, authorized by the
  // intent's own client secret — never from a field on the intent, which is
  // the whole reason the DTO carries none.
  expect(getClientActionMock).toHaveBeenCalledWith(intent.id, intent.client_secret);
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
  expect((screen.getByRole('button', { name: 'Pay' }) as HTMLButtonElement).disabled).toBe(false);
});

/**
 * A payment that can no longer be paid answers 409 from the resume operation.
 * Rendering an empty box would read to the payer as the merchant's site being
 * broken.
 */
test('says so when the credential cannot be obtained', async () => {
  clientAction = new Error("this payment is 'succeeded' and can no longer be paid");
  render(<CardPayment intent={cardIntent()} />);

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('succeeded');
  expect(screen.queryByRole('button', { name: 'Pay' })).toBeNull();
});

/** The provider's iframe is destroyed on unmount — React only removes OUR node. */
test('tears down the provider element when it unmounts', async () => {
  const { unmount } = render(<CardPayment intent={cardIntent()} />);
  await waitFor(() => {
    expect(mounted).toHaveLength(2);
  });

  unmount();

  expect(destroyMock).toHaveBeenCalled();
});

/**
 * Which intents get a card form.
 *
 * A declined attempt is INCLUDED, and that is the retry: it returns the payment
 * to `requires_payment_method` with `last_payment_error` (ADR 0019), and
 * dropping the payer onto a dead status panel because their first card was
 * declined loses a sale they were still trying to make.
 */
test('offers the form for every status a card payment can still be paid from', () => {
  expect(isPayableCardIntent(cardIntent({ status: 'requires_payment_method' }))).toBe(true);
  expect(isPayableCardIntent(cardIntent({ status: 'requires_confirmation' }))).toBe(true);
  expect(isPayableCardIntent(cardIntent({ status: 'requires_action' }))).toBe(true);
  expect(
    isPayableCardIntent(
      cardIntent({
        status: 'requires_payment_method',
        last_payment_error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: null,
          message: 'The card was declined.',
        },
      }),
    ),
  ).toBe(true);

  expect(isPayableCardIntent(cardIntent({ status: 'processing' }))).toBe(false);
  expect(isPayableCardIntent(cardIntent({ status: 'requires_capture' }))).toBe(false);
  expect(isPayableCardIntent(cardIntent({ status: 'succeeded' }))).toBe(false);
  expect(isPayableCardIntent(cardIntent({ status: 'canceled' }))).toBe(false);
  // ...and never the other rail, whose payer is told an address instead.
  expect(isPayableCardIntent(cardIntent({ rail: 'faircoin', status: 'requires_action' }))).toBe(
    false,
  );
});

/** A payer returning to a declined payment is told why before trying another card. */
test("shows the gateway's last_payment_error on a declined payment", async () => {
  render(
    <CardPayment
      intent={cardIntent({
        last_payment_error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: 'The card has insufficient funds.',
        },
      })}
    />,
  );
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('insufficient funds');
});

/**
 * The wallet slot is shown only when the provider says this device runs a
 * wallet. An empty box above the form reads to a payer as a broken page.
 */
test('shows the wallets only once the provider reports one this device can run', async () => {
  render(<CardPayment intent={cardIntent()} />);
  await waitFor(() => {
    expect(mounted).toHaveLength(2);
  });
  const slot = screen.getByTestId('wallet-fields');
  expect(slot.hidden).toBe(true);

  await act(async () => {
    elementHandlers.get('expressCheckout:ready')?.({});
  });
  expect(slot.hidden).toBe(true);

  await act(async () => {
    elementHandlers.get('expressCheckout:ready')?.({
      availablePaymentMethods: { applePay: true, googlePay: false },
    });
  });
  expect(slot.hidden).toBe(false);
  expect(screen.getByText('Or pay another way')).toBeDefined();
});

/** A wallet confirmation goes through the same path, and is not success either. */
test('confirms a wallet payment through the same path, without announcing success', async () => {
  render(<CardPayment intent={cardIntent()} />);
  await waitFor(() => {
    expect(mounted).toHaveLength(2);
  });
  await act(async () => {
    elementHandlers.get('expressCheckout:confirm')?.({ paymentFailed: () => undefined });
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDefined();
  });
  expect(confirmMock).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/succeeded|paid/i)).toBeNull();
});

/**
 * Back from a bank's page (iDEAL, Bancontact, EPS): the payer CAME BACK, which
 * is not a payment. The page waits for the gateway instead of mounting a fresh
 * form that would invite a second attempt — and the provider's client secret
 * leaves the address bar.
 */
test('waits for the gateway after a bank redirect, and drops the secret from the URL', async () => {
  window.history.replaceState(
    null,
    '',
    '/i/pi_card_1?payment_intent=pi_p&payment_intent_client_secret=pi_p_secret_s&redirect_status=succeeded',
  );
  render(<CardPayment intent={cardIntent({ status: 'requires_action' })} />);

  expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDefined();
  expect(screen.getByText('Confirming your payment…')).toBeDefined();
  await waitFor(() => {
    expect(window.location.search).toBe('');
  });
  expect(getClientActionMock).not.toHaveBeenCalled();
  expect(mounted).toHaveLength(0);
});

/** A failed redirect offers the form again on the same payment. */
test('offers the form again after a redirect the bank failed', async () => {
  window.history.replaceState(
    null,
    '',
    '/i/pi_card_1?payment_intent_client_secret=pi_p_secret_s&redirect_status=failed',
  );
  render(<CardPayment intent={cardIntent()} />);
  expect(screen.getByRole('alert').textContent).toContain('not completed');
  await waitFor(() => {
    expect(mounted).toHaveLength(2);
  });
});
