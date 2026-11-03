import {
  createPeableElements,
  readRedirectReturn,
  withoutRedirectParams,
} from '@peable.to/sdk/checkout';
import type { OrderView } from './order';

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

const form = element<HTMLFormElement>('#payment-form');
const button = element<HTMLButtonElement>('#pay');
const message = element<HTMLParagraphElement>('#message');

async function api(path: string, init?: RequestInit): Promise<OrderView> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as OrderView;
}

/** The order in the address bar, so a reload or a 3-D Secure return resumes it. */
async function currentOrder(): Promise<OrderView> {
  const url = new URL(location.href);
  const id = url.searchParams.get('order');
  if (id) return api(`/api/orders/${encodeURIComponent(id)}`);
  const order = await api('/api/orders', { method: 'POST' });
  url.searchParams.set('order', order.id);
  history.replaceState(null, '', url);
  return order;
}

function show(order: OrderView): void {
  const amount = `${(Number(order.amount) / 100).toFixed(2)} ${order.currency}`;
  const text = {
    awaiting_payment: `Pay ${amount}`,
    processing: 'Confirming your payment…',
    paid: `Paid ${amount}. Thank you!`,
    canceled: 'This payment was canceled.',
  } as const;
  message.textContent = text[order.status];
  form.hidden = order.status !== 'awaiting_payment';
}

/**
 * Ask the SERVER until it has an answer. The browser's confirmation means the
 * provider accepted the attempt; the order is paid when the server, reading
 * the payment from Peable (and its webhook), says so.
 */
async function waitForServer(id: string): Promise<OrderView> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const order = await api(`/api/orders/${encodeURIComponent(id)}`);
    show(order);
    if (order.status !== 'processing') return order;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return api(`/api/orders/${encodeURIComponent(id)}`);
}

async function main(): Promise<void> {
  // Back from a redirect-based step (3-D Secure, a bank page): drop the
  // provider's parameters from the address bar, then ask the server.
  const returned = readRedirectReturn(location.search);
  if (returned) history.replaceState(null, '', withoutRedirectParams(location.href));

  let order = await currentOrder();
  show(order);
  if (returned?.outcome === 'returned' || order.status === 'processing') {
    order = await waitForServer(order.id);
  }
  const payment = order.payment_intent;
  if (order.status !== 'awaiting_payment' || !payment) return;
  if (returned?.outcome === 'failed') message.textContent = 'That attempt failed. Try again.';

  const elements = createPeableElements({
    paymentIntent: payment,
    appearance: { theme: 'peable', variables: { colorPrimary: '#0A7CFF', borderRadius: '8px' } },
    gatewayUrl: import.meta.env.VITE_PEABLE_API_URL,
  });
  await elements.create('payment').mount('#payment');
  button.disabled = false;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    const result = await elements.confirmPayment({
      paymentIntent: payment,
      return_url: location.href,
    });
    if ('error' in result) {
      // A decline leaves the same payment payable: let the payer try again.
      message.textContent = result.error.message;
      button.disabled = false;
      return;
    }
    const final = await waitForServer(order.id);
    if (final.status === 'awaiting_payment') button.disabled = false;
  });
}

main().catch((error: unknown) => {
  message.textContent = error instanceof Error ? error.message : 'Something went wrong.';
});
