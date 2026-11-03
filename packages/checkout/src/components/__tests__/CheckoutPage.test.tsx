import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { installCheckoutMocks, mocks, resetMocks } from '../../__tests__/checkoutMocks';
import { intentFixture } from '../../__tests__/intentFixture';
import { lineItemFixture, refusal, sessionFixture } from '../../__tests__/sessionFixture';

installCheckoutMocks();
const { CheckoutPage } = await import('../CheckoutPage');
const { QUANTITY_DEBOUNCE_MS } = await import('../OrderSummary');

const SECRET = 'cs_0123456789abcdef01234567_secret_00112233445566778899aabbccddeeff';

beforeEach(() => {
  resetMocks();
});
afterEach(() => {
  cleanup();
});

test('renders the order with the gateway totals, discount and tax lines', () => {
  render(
    <CheckoutPage
      initialSession={sessionFixture({
        amount_subtotal: '2000',
        amount_total: '1980',
        total_details: { amount_discount: '200', amount_tax: '180', amount_shipping: '0' },
        discount: {
          promotion_code: 'SPRING',
          coupon_name: null,
          amount_off: null,
          percent_off: 10,
        },
        automatic_tax: { enabled: true, status: 'complete' },
      })}
      clientSecret={SECRET}
    />,
  );
  expect(screen.getByText('Notebook')).toBeTruthy();
  expect(screen.getByText('€10.00 each')).toBeTruthy();
  expect(screen.getByText('Discount (SPRING)')).toBeTruthy();
  expect(screen.getByText('−€2.00')).toBeTruthy();
  expect(screen.getByText('€1.80')).toBeTruthy();
  expect(screen.getByTestId('amount-total').textContent).toBe('€19.80');
  expect(screen.getByRole('button', { name: 'Pay €19.80' })).toBeTruthy();
});

test('an adjustable quantity is sent once the payer stops, and the answer replaces the totals', async () => {
  const line = lineItemFixture({
    quantity: 1,
    amount_subtotal: '1000',
    adjustable_quantity: { enabled: true, minimum: 1, maximum: 3 },
  });
  mocks.updateCheckoutSession.mockImplementation(async () =>
    sessionFixture({
      line_items: [{ ...line, quantity: 3, amount_subtotal: '3000' }],
      amount_subtotal: '3000',
      amount_total: '3000',
    }),
  );
  render(
    <CheckoutPage
      initialSession={sessionFixture({
        line_items: [line],
        amount_subtotal: '1000',
        amount_total: '1000',
      })}
      clientSecret={SECRET}
    />,
  );
  const increase = screen.getByRole('button', { name: 'Increase quantity of Notebook' });
  fireEvent.click(increase);
  fireEvent.click(increase);
  // At the maximum: the stepper refuses to go further.
  expect((increase as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.updateCheckoutSession).not.toHaveBeenCalled();

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, QUANTITY_DEBOUNCE_MS + 50));
  });
  expect(mocks.updateCheckoutSession).toHaveBeenCalledTimes(1);
  expect(mocks.updateCheckoutSession.mock.calls[0]?.[2]).toEqual({
    line_items: [{ id: line.id, quantity: 3 }],
  });
  await waitFor(() => {
    expect(screen.getByTestId('amount-total').textContent).toBe('€30.00');
  });
});

test('a refused promotion code is shown at the code field', async () => {
  mocks.updateCheckoutSession.mockImplementation(async () => {
    throw refusal('This code has expired.', 'promotion_code');
  });
  render(
    <CheckoutPage
      initialSession={sessionFixture({ allow_promotion_codes: true })}
      clientSecret={SECRET}
    />,
  );
  fireEvent.change(screen.getByLabelText('Promotion code'), { target: { value: 'OLD' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('This code has expired.');
  expect(screen.getByLabelText('Promotion code').getAttribute('aria-invalid')).toBe('true');
  expect(mocks.updateCheckoutSession.mock.calls[0]?.[2]).toEqual({ promotion_code: 'OLD' });
});

test('an applied code can be removed', async () => {
  mocks.updateCheckoutSession.mockImplementation(async () =>
    sessionFixture({ allow_promotion_codes: true }),
  );
  render(
    <CheckoutPage
      initialSession={sessionFixture({
        allow_promotion_codes: true,
        discount: {
          promotion_code: 'SPRING',
          coupon_name: null,
          amount_off: null,
          percent_off: 10,
        },
      })}
      clientSecret={SECRET}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => {
    expect(screen.getByLabelText('Promotion code')).toBeTruthy();
  });
  expect(mocks.updateCheckoutSession.mock.calls[0]?.[2]).toEqual({ promotion_code: '' });
});

test('a required field the gateway names is shown at that field (bracket param)', async () => {
  mocks.confirmCheckoutSession.mockImplementation(async () => {
    throw refusal('Enter your email.', 'customer_details[email]');
  });
  render(<CheckoutPage initialSession={sessionFixture()} clientSecret={SECRET} />);
  fireEvent.click(screen.getByRole('button', { name: 'Pay €20.00' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('Enter your email.');
  expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
  // Nothing filled in, so nothing was sent before the confirm.
  expect(mocks.updateCheckoutSession).not.toHaveBeenCalled();
});

test('collected fields are sent with the order, and a custom field refused by index is shown at its key', async () => {
  const session = sessionFixture({
    billing_address_collection: 'required',
    phone_number_collection: { enabled: true },
    consent_collection: { terms_of_service: 'required' },
    terms_of_service_url: 'https://merchant.example/terms',
    custom_fields: [
      {
        key: 'size',
        label: { type: 'custom', custom: 'T-shirt size' },
        type: 'dropdown',
        optional: false,
        dropdown: {
          options: [
            { label: 'Small', value: 's' },
            { label: 'Large', value: 'l' },
          ],
          value: null,
        },
        text: null,
        numeric: null,
      },
    ],
  });
  mocks.updateCheckoutSession.mockImplementation(async () => {
    throw refusal('This option is not available.', 'custom_fields[0][value]');
  });
  render(<CheckoutPage initialSession={session} clientSecret={SECRET} />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@example.com' } });
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+34600000000' } });
  fireEvent.change(screen.getByLabelText('Country (2-letter code)'), { target: { value: 'es' } });
  fireEvent.change(screen.getByLabelText('Address line 1'), { target: { value: 'Calle 1' } });
  fireEvent.change(screen.getByLabelText('T-shirt size'), { target: { value: 'l' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Pay €20.00' }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('This option is not available.');
  expect(screen.getByLabelText('T-shirt size').getAttribute('aria-invalid')).toBe('true');
  expect(mocks.updateCheckoutSession.mock.calls[0]?.[2]).toEqual({
    customer_details: {
      email: 'ana@example.com',
      phone: '+34600000000',
      address: { country: 'ES', line1: 'Calle 1' },
    },
    custom_fields: [{ key: 'size', value: 'l' }],
    consent: { terms_of_service: 'accepted' },
  });
  expect(mocks.confirmCheckoutSession).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'terms of service' }).getAttribute('href')).toBe(
    'https://merchant.example/terms',
  );
});

test('a locked email is shown read-only and never sent', async () => {
  mocks.confirmCheckoutSession.mockImplementation(async () =>
    sessionFixture({
      payment_intent: intentFixture({ rail: 'card', client_secret: 'pi_live123_secret_x' }),
    }),
  );
  render(
    <CheckoutPage
      initialSession={sessionFixture({
        customer_email_locked: true,
        customer_details: {
          email: 'locked@example.com',
          name: null,
          phone: null,
          address: null,
          tax_ids: [],
        },
      })}
      clientSecret={SECRET}
    />,
  );
  const email = screen.getByLabelText('Email') as HTMLInputElement;
  expect(email.value).toBe('locked@example.com');
  expect(email.readOnly).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Pay €20.00' }));
  await screen.findByRole('heading', { name: 'Payment' });
  expect(mocks.updateCheckoutSession).not.toHaveBeenCalled();
});

test('a FairCoin order, once confirmed, is locked and shows the wallet payment', async () => {
  const intent = intentFixture({ amount: '100000000' });
  mocks.confirmCheckoutSession.mockImplementation(async () =>
    sessionFixture({
      currency: 'FAIR',
      rail: 'faircoin',
      network: 'testnet',
      line_items: [
        lineItemFixture({
          currency: 'FAIR',
          unit_amount: '50000000',
          amount_subtotal: '100000000',
        }),
      ],
      amount_subtotal: '100000000',
      amount_total: '100000000',
      payment_intent: intent,
    }),
  );
  render(
    <CheckoutPage
      initialSession={sessionFixture({
        currency: 'FAIR',
        rail: 'faircoin',
        network: 'testnet',
        line_items: [
          lineItemFixture({
            currency: 'FAIR',
            unit_amount: '50000000',
            amount_subtotal: '100000000',
            adjustable_quantity: { enabled: true, minimum: 1, maximum: 5 },
          }),
        ],
        amount_subtotal: '100000000',
        amount_total: '100000000',
      })}
      clientSecret={SECRET}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Pay 1 FAIR' }));
  const heading = await screen.findByRole('heading', { name: 'Payment' });
  expect(document.activeElement).toBe(heading);
  expect(screen.getByText('Scan with the Peable app')).toBeTruthy();
  // Locked: no stepper any more.
  expect(screen.queryByRole('button', { name: /Increase quantity/ })).toBeNull();
  expect(screen.getByText('Qty 2')).toBeTruthy();
});

test('redirects only once the GATEWAY reports the session complete, never on the provider callback', async () => {
  const intent = intentFixture({ rail: 'card', status: 'requires_payment_method' });
  const paying = sessionFixture({
    payment_intent: intent,
    success_url: 'https://merchant.example/thanks?session=cs_0123456789abcdef01234567',
  });
  // The re-read after the provider accepted: still open.
  mocks.getCheckoutSession.mockImplementation(async () => paying);
  render(<CheckoutPage initialSession={paying} clientSecret={SECRET} />);

  const pay = await screen.findByRole('button', { name: 'Pay €20.00' });
  await waitFor(() => {
    expect((pay as HTMLButtonElement).disabled).toBe(false);
  });
  await act(async () => {
    pay.click();
  });
  expect(mocks.confirmPayment).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Confirming…' })).toBeTruthy();
  expect(mocks.redirectTo).not.toHaveBeenCalled();

  // The gateway moves the payment; the page re-reads the session — still open.
  await act(async () => {
    mocks.intentListener?.({ ...intent, status: 'processing' });
  });
  await waitFor(() => {
    expect(mocks.getCheckoutSession).toHaveBeenCalled();
  });
  expect(mocks.redirectTo).not.toHaveBeenCalled();

  // …and only when the session itself is complete does the payer leave.
  mocks.getCheckoutSession.mockImplementation(async () => ({
    ...paying,
    status: 'complete',
    payment_status: 'paid',
  }));
  await act(async () => {
    mocks.intentListener?.({ ...intent, status: 'succeeded' });
  });
  await waitFor(() => {
    expect(mocks.redirectTo).toHaveBeenCalledWith(
      'https://merchant.example/thanks?session=cs_0123456789abcdef01234567',
    );
  });
  expect(mocks.redirectTo).toHaveBeenCalledTimes(1);
});

test('a complete session without success_url shows the confirmation and the merchant message', () => {
  render(
    <CheckoutPage
      initialSession={sessionFixture({
        status: 'complete',
        payment_status: 'paid',
        confirmation_message: 'See you at the workshop!',
      })}
      clientSecret={SECRET}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Thank you' })).toBeTruthy();
  expect(screen.getByText('Your payment was received.')).toBeTruthy();
  expect(screen.getByText('See you at the workshop!')).toBeTruthy();
  expect(mocks.redirectTo).not.toHaveBeenCalled();
});

test('an expired session shows the expired state with the way back', () => {
  render(
    <CheckoutPage
      initialSession={sessionFixture({
        status: 'expired',
        cancel_url: 'https://merchant.example/cart',
      })}
      clientSecret={SECRET}
    />,
  );
  expect(screen.getByRole('heading', { name: 'This checkout has expired' })).toBeTruthy();
  expect(screen.getByRole('link', { name: /Back to Test Merchant/ }).getAttribute('href')).toBe(
    'https://merchant.example/cart',
  );
  expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull();
});

test('a session past its expires_at is expired even before the gateway says so', () => {
  render(
    <CheckoutPage
      initialSession={sessionFixture({ expires_at: Math.floor(Date.now() / 1000) - 5 })}
      clientSecret={SECRET}
    />,
  );
  expect(screen.getByRole('heading', { name: 'This checkout has expired' })).toBeTruthy();
});

test('the cancel link is offered before payment and gone once the order is locked', () => {
  const { unmount } = render(
    <CheckoutPage
      initialSession={sessionFixture({ cancel_url: 'https://merchant.example/cart' })}
      clientSecret={SECRET}
    />,
  );
  expect(screen.getByRole('link', { name: /Back to Test Merchant/ })).toBeTruthy();
  unmount();
  render(
    <CheckoutPage
      initialSession={sessionFixture({
        cancel_url: 'https://merchant.example/cart',
        payment_intent: intentFixture({ rail: 'card' }),
      })}
      clientSecret={SECRET}
    />,
  );
  expect(screen.queryByRole('link', { name: /Back to Test Merchant/ })).toBeNull();
});

test('tax that cannot be calculated fails closed: no payment', () => {
  render(
    <CheckoutPage
      initialSession={sessionFixture({ automatic_tax: { enabled: true, status: 'failed' } })}
      clientSecret={SECRET}
    />,
  );
  expect(screen.getByRole('alert').textContent).toContain('Tax cannot be calculated');
  expect((screen.getByRole('button', { name: 'Pay €20.00' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test("the merchant's branding becomes the page's CSS variables and the provider's appearance", async () => {
  const branding = {
    icon_url: 'https://cdn.example/icon.png',
    logo_url: null,
    primary_color: '#aa3300',
    accent_color: '#003344',
    font: 'serif' as const,
    border_style: 'pill' as const,
  };
  const { container } = render(
    <CheckoutPage
      initialSession={sessionFixture({ branding, payment_intent: intentFixture({ rail: 'card' }) })}
      clientSecret={SECRET}
    />,
  );
  const shell = container.querySelector('.checkout-shell') as HTMLElement;
  expect(shell.style.getPropertyValue('--peable-color-primary')).toBe('#aa3300');
  expect(shell.style.getPropertyValue('--peable-border-radius')).toBe('999px');
  expect(shell.style.getPropertyValue('--peable-font-family')).toContain('Georgia');
  expect(shell.style.getPropertyValue('--peable-color-accent')).toBe('#003344');
  expect(container.querySelector('.brand-header__icon')?.getAttribute('src')).toBe(
    'https://cdn.example/icon.png',
  );
  await waitFor(() => {
    expect(mocks.elementsOptions).toHaveLength(1);
  });
  const appearance = mocks.elementsOptions[0]?.appearance as {
    variables: Record<string, string>;
  };
  expect(appearance.variables.colorPrimary).toBe('#aa3300');
  expect(appearance.variables.borderRadius).toBe('999px');
});

test('setup mode saves the card and completes only when the gateway says so', async () => {
  const setup = sessionFixture({
    mode: 'setup',
    payment_status: 'no_payment_required',
    line_items: [],
    amount_subtotal: '0',
    amount_total: '0',
    setup_intent: {
      id: 'seti_0123456789abcdef01234567',
      client_secret: 'seti_0123456789abcdef01234567_secret_aa',
      status: 'requires_payment_method',
    },
  });
  mocks.getCheckoutSession.mockImplementation(async () => ({ ...setup, status: 'complete' }));
  render(<CheckoutPage initialSession={setup} clientSecret={SECRET} />);
  const save = await screen.findByRole('button', { name: 'Save payment details' });
  await waitFor(() => {
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });
  expect(mocks.getSetupClientAction).toHaveBeenCalledWith(
    'seti_0123456789abcdef01234567',
    'seti_0123456789abcdef01234567_secret_aa',
  );
  await act(async () => {
    save.click();
  });
  expect(mocks.confirmSetup).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('Your payment details were saved.')).toBeTruthy();
});
