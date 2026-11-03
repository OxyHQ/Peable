import {
  PeableError,
  PeableSignatureVerificationError,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEvent,
} from '@peable.to/sdk';
import { peable, webhookSecret } from './peable';

const PORT = Number(process.env.PORT ?? 4242);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

// What this shop sells. The price is the server's, never the browser's.
const PRODUCT = { name: 'Enamel mug', currency: 'EUR', unit_amount: '1800' } as const;

type OrderStatus = 'pending' | 'paid' | 'failed' | 'expired';

interface Order {
  id: string;
  sessionId: string | null;
  status: OrderStatus;
}

// Stand-in for your database.
const orders = new Map<string, Order>();

/**
 * The ONE place an order changes state, reached from the success page and
 * from the webhook alike. It reads the session from Peable, so neither a
 * redirect nor a payload decides anything, and it is idempotent: calling it
 * twice for a paid order fulfils it once.
 */
async function syncOrder(sessionId: string): Promise<Order | null> {
  const session = await peable.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent'],
  });
  const order = session.client_reference_id ? orders.get(session.client_reference_id) : undefined;
  if (!order || order.sessionId !== session.id) return null; // not one of ours
  if (order.status === 'paid') return order;

  // A FairCoin payment completes the session while it confirms on chain
  // (`payment_status: 'unpaid'`); only `paid` is money received.
  if (session.status === 'complete' && session.payment_status === 'paid') {
    order.status = 'paid';
    console.log(`fulfilling order ${order.id}`); // ship the mug, send the receipt, …
  } else if (session.status === 'expired') {
    order.status = 'expired';
  } else if (expanded(session.payment_intent)?.status === 'canceled') {
    order.status = 'failed';
  }
  return order;
}

/** An expandable reference, as the object it was expanded to. */
function expanded<T extends object>(reference: string | T | null): T | null {
  return typeof reference === 'string' ? null : reference;
}

async function createCheckout(): Promise<Response> {
  const order: Order = { id: crypto.randomUUID(), sessionId: null, status: 'pending' };
  orders.set(order.id, order);

  const session = await peable.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: PRODUCT.currency,
            unit_amount: PRODUCT.unit_amount,
            product_data: { name: PRODUCT.name },
          },
          quantity: 1,
        },
      ],
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/`,
      client_reference_id: order.id,
      metadata: { order_id: order.id },
    },
    // One key per order: a retried create returns this session, not a second one.
    { idempotencyKey: `checkout:${order.id}` },
  );
  order.sessionId = session.id;
  if (!session.url) throw new Error('a hosted session always has a url');
  return Response.redirect(session.url, 303);
}

async function success(request: Request): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get('session_id');
  const order = sessionId ? await syncOrder(sessionId) : null;
  if (!order) return page('Order not found', '<p>We have no order for this link.</p>', 404);

  const messages: Record<OrderStatus, string> = {
    paid: 'Thank you: your payment was received and your order is on its way.',
    pending: 'Your payment is being confirmed. This page refreshes on its own.',
    failed: 'The payment did not go through. You have not been charged.',
    expired: 'This checkout expired before it was paid.',
  };
  const refresh = order.status === 'pending' ? '<meta http-equiv="refresh" content="5">' : '';
  return page(`Order ${order.status}`, `${refresh}<p>${messages[order.status]}</p>`);
}

async function webhook(request: Request): Promise<Response> {
  const signature = request.headers.get(WEBHOOK_SIGNATURE_HEADER);
  // The signature covers the exact bytes: read the raw body, never a re-serialized object.
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
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      await syncOrder(event.data.object.id);
      break;
  }
  return Response.json({ received: true });
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body><h1>${title}</h1>${body}<p><a href="/">Back to the shop</a></p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function home(): Response {
  const price = `${(Number(PRODUCT.unit_amount) / 100).toFixed(2)} ${PRODUCT.currency}`;
  return page(
    PRODUCT.name,
    `<p>${price}</p><form method="post" action="/checkout"><button>Buy</button></form>`,
  );
}

Bun.serve({
  port: PORT,
  routes: {
    '/': home,
    '/checkout': { POST: createCheckout },
    '/success': { GET: success },
    '/webhooks': { POST: webhook },
  },
  fetch: () => new Response('Not found', { status: 404 }),
  error(error) {
    console.error(error);
    const detail = error instanceof PeableError ? ` (${error.code ?? error.type})` : '';
    return new Response(`Something went wrong${detail}`, { status: 500 });
  },
});

console.log(`Shop on ${BASE_URL}`);
