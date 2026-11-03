import {
  type PaymentIntent,
  PeableError,
  PeableSignatureVerificationError,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEvent,
} from '@peable.to/sdk';
import { peable, webhookSecret } from './peable';
import type { OrderStatus, OrderView } from './src/order';

const PORT = Number(process.env.PORT ?? 4242);

// What the page sells. The amount is decided here, never by the browser.
const PRODUCT = { description: 'Enamel mug', amount: '1800', currency: 'EUR' } as const;

interface Order {
  id: string;
  paymentIntentId: string;
  fulfilled: boolean;
}

// Stand-in for your database.
const orders = new Map<string, Order>();

function statusOf(intent: PaymentIntent): OrderStatus {
  switch (intent.status) {
    case 'succeeded':
      return 'paid';
    case 'processing':
    case 'requires_capture':
      return 'processing';
    case 'canceled':
      return 'canceled';
    default:
      return 'awaiting_payment';
  }
}

/**
 * Read the payment from Peable and fulfil the order when it succeeded —
 * once, whether the webhook or the page's poll gets here first.
 */
async function syncOrder(order: Order): Promise<OrderView> {
  const intent = await peable.paymentIntents.retrieve(order.paymentIntentId);
  const status = statusOf(intent);
  if (status === 'paid' && !order.fulfilled) {
    order.fulfilled = true;
    console.log(`fulfilling order ${order.id}`); // ship it, send the receipt, …
  }
  return {
    id: order.id,
    status,
    amount: intent.amount,
    currency: intent.currency,
    payment_intent:
      status === 'awaiting_payment' ? { id: intent.id, client_secret: intent.client_secret } : null,
  };
}

async function createOrder(): Promise<Response> {
  const id = crypto.randomUUID();
  const intent = await peable.paymentIntents.create(
    {
      rail: 'card',
      amount: PRODUCT.amount,
      currency: PRODUCT.currency,
      description: PRODUCT.description,
      metadata: { order_id: id },
    },
    // One key per order: a retried create returns this payment, not a second one.
    { idempotencyKey: `order:${id}` },
  );
  const order: Order = { id, paymentIntentId: intent.id, fulfilled: false };
  orders.set(id, order);
  return Response.json(await syncOrder(order), { status: 201 });
}

async function readOrder(id: string): Promise<Response> {
  const order = orders.get(id);
  if (!order) return Response.json({ error: 'order not found' }, { status: 404 });
  return Response.json(await syncOrder(order));
}

async function webhook(request: Request): Promise<Response> {
  const signature = request.headers.get(WEBHOOK_SIGNATURE_HEADER);
  // The signature covers the exact bytes: read the raw body.
  const body = await request.text();
  if (!signature) return new Response('missing signature', { status: 400 });

  let event: WebhookEvent;
  try {
    event = peable.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (error) {
    if (error instanceof PeableSignatureVerificationError) {
      return new Response('bad signature', { status: 400 });
    }
    throw error;
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
    case 'payment_intent.processing':
    case 'payment_intent.canceled': {
      const order = orders.get(event.data.object.metadata.order_id ?? '');
      if (order) await syncOrder(order);
      break;
    }
    // A decline is not the end: the payer can try another card on the same payment.
    case 'payment_intent.payment_failed':
      console.log(`payment ${event.data.object.id} declined; the payer may retry`);
      break;
  }
  return Response.json({ received: true });
}

Bun.serve({
  port: PORT,
  routes: {
    '/api/orders': { POST: createOrder },
    '/api/orders/:id': { GET: (request) => readOrder(request.params.id) },
    '/webhooks': { POST: webhook },
  },
  fetch: () => new Response('Not found', { status: 404 }),
  error(error) {
    console.error(error);
    const code = error instanceof PeableError ? (error.code ?? error.type) : 'internal_error';
    return Response.json({ error: code }, { status: 500 });
  },
});

console.log(`API on http://localhost:${PORT}`);
