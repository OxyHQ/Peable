import {
  PeableError,
  PeableSignatureVerificationError,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEvent,
} from '@peable.to/sdk';
import { peable, webhookSecret } from './peable';

const PORT = Number(process.env.PORT ?? 4242);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const CURRENCY = 'EUR';

// The platform's fee. Peable never computes a split: every amount is yours.
const FEE_PERCENT = 10n;

/**
 * - `destination`: one charge whose funds go to the seller, less the
 *   `application_fee_amount` the platform keeps.
 * - `separate`: the platform charges, then pays the seller with a transfer
 *   once the payment succeeded.
 */
type Flow = 'destination' | 'separate';

interface Order {
  id: string;
  sellerRef: string;
  flow: Flow;
  amount: string;
  fee: string;
  paymentIntentId: string;
}

// Stand-in for your database. Sellers need no table here: Peable finds each
// one by YOUR reference (`retrieveByRef`), which is what makes a lost `ca_…`
// recoverable.
const orders = new Map<string, Order>();

class BadRequest extends Error {}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null) throw new BadRequest('send a JSON object');
  return body as Record<string, unknown>;
}

function text(body: Record<string, unknown>, field: string, pattern: RegExp): string {
  const value = body[field];
  if (typeof value !== 'string' || !pattern.test(value)) throw new BadRequest(`invalid ${field}`);
  return value;
}

/** Open the seller's account (card half). Repeating it converges on the same `ca_…`. */
async function createSeller(request: Request): Promise<Response> {
  const body = await readJson(request);
  const seller = await peable.connectedAccounts.create({
    external_ref: text(body, 'ref', /^[\w-]{1,100}$/),
    country: text(body, 'country', /^[A-Za-z]{2}$/),
    business_type:
      text(body, 'business_type', /^(individual|company)$/) === 'company'
        ? 'company'
        : 'individual',
  });
  return Response.json(seller, { status: 201 });
}

/**
 * Hosted onboarding. The link is single-use and short-lived: mint it when the
 * seller clicks, never store or email it. It is also the `refresh_url`, so an
 * expired link mints a fresh one.
 */
async function onboard(ref: string): Promise<Response> {
  const seller = await peable.connectedAccounts.retrieveByRef(ref);
  const link = await peable.connectedAccounts.createAccountLink(seller.id, {
    rail: 'card',
    refresh_url: `${BASE_URL}/sellers/${encodeURIComponent(ref)}/onboard`,
    return_url: `${BASE_URL}/sellers/${encodeURIComponent(ref)}/return`,
  });
  return Response.redirect(link.url, 303);
}

/** Arriving here proves nothing: read the account back from the provider. */
async function onboardingReturn(ref: string): Promise<Response> {
  const seller = await peable.connectedAccounts.retrieveByRef(ref);
  const fresh = await peable.connectedAccounts.refresh(seller.id);
  return Response.json({
    seller: fresh.id,
    payable: fresh.payable,
    charges_enabled: fresh.charges_enabled,
    payouts_enabled: fresh.payouts_enabled,
    currently_due: fresh.requirements.currently_due,
  });
}

/**
 * Create the order's card payment. The payer confirms it with its
 * `client_secret` in Peable Elements (see ../elements-vite); the order is
 * paid on `payment_intent.succeeded`, never on the browser's word.
 */
async function createOrder(request: Request): Promise<Response> {
  const body = await readJson(request);
  const sellerRef = text(body, 'seller', /^[\w-]{1,100}$/);
  const amount = text(body, 'amount', /^[1-9]\d{0,11}$/);
  const flow: Flow =
    text(body, 'flow', /^(destination|separate)$/) === 'separate' ? 'separate' : 'destination';
  const fee = ((BigInt(amount) * FEE_PERCENT) / 100n).toString();
  const seller = await peable.connectedAccounts.retrieveByRef(sellerRef);
  const id = crypto.randomUUID();

  const intent = await peable.paymentIntents.create(
    {
      rail: 'card',
      amount,
      currency: CURRENCY,
      metadata: { order_id: id, seller: sellerRef },
      ...(flow === 'destination'
        ? { transfer_data: { destination: seller.id }, application_fee_amount: fee }
        : {}),
    },
    { idempotencyKey: `order:${id}` },
  );
  orders.set(id, { id, sellerRef, flow, amount, fee, paymentIntentId: intent.id });
  return Response.json(
    { order: id, payment_intent: { id: intent.id, client_secret: intent.client_secret } },
    { status: 201 },
  );
}

/**
 * Pay the seller their share of a `separate` order. `external_ref` is the
 * idempotency, and it is durable: a redelivered event converges on the same
 * transfer instead of paying the seller twice.
 */
async function settle(order: Order): Promise<void> {
  const transfer = await peable.transfers.create({
    payment_intent: order.paymentIntentId,
    connected_account_ref: order.sellerRef,
    external_ref: `order:${order.id}`,
    amount: (BigInt(order.amount) - BigInt(order.fee)).toString(),
  });
  console.log(
    `order ${order.id}: transfer ${transfer.id} of ${transfer.amount} to ${order.sellerRef}`,
  );
}

/** What the seller holds and was paid, read with the platform's credential. */
async function sellerBalance(ref: string): Promise<Response> {
  const seller = await peable.connectedAccounts.retrieveByRef(ref);
  const [balance, transfers] = await Promise.all([
    peable.balance.retrieve({}, { peableAccount: seller.id }),
    peable.transfers.list({ connected_account: seller.id, limit: 10 }),
  ]);
  return Response.json({
    available: balance.available,
    pending: balance.pending,
    transfers: transfers.data.map(({ id, amount, currency, amount_reversed, status }) => ({
      id,
      amount,
      currency,
      amount_reversed,
      status,
    })),
  });
}

async function webhook(request: Request): Promise<Response> {
  const signature = request.headers.get(WEBHOOK_SIGNATURE_HEADER);
  const body = await request.text(); // the raw bytes the signature covers
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
    case 'payment_intent.succeeded': {
      const order = orders.get(event.data.object.metadata.order_id ?? '');
      if (order?.flow === 'separate') await settle(order);
      break;
    }
    // How you learn a seller finished onboarding — or stopped being payable.
    case 'connected_account.updated': {
      const seller = event.data.object;
      console.log(`seller ${seller.external_ref}: payable=${seller.payable}`);
      break;
    }
    case 'application_fee.created':
      console.log(`fee ${event.data.object.id} collected on a destination charge`);
      break;
  }
  return Response.json({ received: true });
}

Bun.serve({
  port: PORT,
  routes: {
    '/sellers': { POST: createSeller },
    '/sellers/:ref/onboard': { GET: (request) => onboard(request.params.ref) },
    '/sellers/:ref/return': { GET: (request) => onboardingReturn(request.params.ref) },
    '/sellers/:ref/balance': { GET: (request) => sellerBalance(request.params.ref) },
    '/orders': { POST: createOrder },
    '/webhooks': { POST: webhook },
  },
  fetch: () => Response.json({ error: 'not_found' }, { status: 404 }),
  error(error) {
    if (error instanceof BadRequest)
      return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof PeableError) {
      // e.g. 409 `account_not_ready` for a seller who has not finished onboarding.
      return Response.json(
        { error: error.code ?? error.type, message: error.message },
        { status: error.statusCode && error.statusCode < 500 ? error.statusCode : 502 },
      );
    }
    console.error(error);
    return Response.json({ error: 'internal_error' }, { status: 500 });
  },
});

console.log(`Marketplace on ${BASE_URL}`);
