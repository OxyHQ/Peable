import {
  PeableSignatureVerificationError,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEvent,
} from '@peable.to/sdk';
import { peable } from './peable';

const PORT = Number(process.env.PORT ?? 4242);

// Every secret the endpoint is signed with, newest first. While a secret is
// rolling (`webhookEndpoints.rollSecret`) Peable signs each delivery with the
// new AND the old secret, one `v1=` signature each: list both here, deploy,
// then drop the old one once the overlap ends.
const SECRETS = (process.env.PEABLE_WEBHOOK_SECRET ?? '')
  .split(',')
  .map((secret) => secret.trim())
  .filter(Boolean);
if (SECRETS.length === 0) throw new Error('PEABLE_WEBHOOK_SECRET is not set: see .env.example');

/**
 * Event ids already accepted. Delivery is at least once — a retry, a
 * redelivery, `peable listen` reconnecting — so one `evt_…` can arrive twice.
 * In production this is a table with a UNIQUE event id (and the queue below
 * is a durable one): insert the row and enqueue in one transaction, and treat
 * a unique violation as "already have it".
 */
const accepted = new Set<string>();
const queue: WebhookEvent[] = [];
let draining = false;

async function receive(request: Request): Promise<Response> {
  const signature = request.headers.get(WEBHOOK_SIGNATURE_HEADER);
  // The RAW body: the signature covers these exact bytes, so never parse and
  // re-serialize before verifying.
  const body = await request.text();
  if (!signature) return new Response('missing signature', { status: 400 });

  let event: WebhookEvent;
  try {
    event = peable.webhooks.constructEvent(body, signature, SECRETS);
  } catch (error) {
    if (error instanceof PeableSignatureVerificationError) {
      return new Response('bad signature', { status: 400 });
    }
    throw error;
  }

  if (accepted.has(event.id)) return Response.json({ received: true, duplicate: true });
  accepted.add(event.id);
  queue.push(event);
  void drain();
  // Answer at once: the work happens after the response. A slow handler is a
  // timed-out delivery, and a timed-out delivery is retried.
  return Response.json({ received: true });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let event = queue.shift(); event; event = queue.shift()) {
      try {
        await handle(event);
      } catch (error) {
        // Already acknowledged, so Peable will not retry it: your own queue must.
        console.error(`event ${event.id} (${event.type}) failed`, error);
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * One branch per event you act on; `event.data.object` is narrowed by
 * `event.type`. Events are not ordered: when the order matters, re-read the
 * object (`peable.paymentIntents.retrieve(id)`, …) and act on what it is now.
 */
async function handle(event: WebhookEvent): Promise<void> {
  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log(`fulfil order ${event.data.object.metadata.order_id ?? event.data.object.id}`);
      break;
    case 'payment_intent.payment_failed':
      // Not the end of a card payment: the payer can retry on the same intent.
      console.log(`payment ${event.data.object.id} declined`);
      break;
    case 'payment_intent.canceled':
      console.log(`release the order of ${event.data.object.id}`);
      break;
    case 'checkout.session.completed':
      console.log(`session ${event.data.object.id} is ${event.data.object.payment_status}`);
      break;
    case 'charge.refunded':
      console.log(`charge ${event.data.object.id} refunded`);
      break;
    case 'charge.dispute.created':
      console.log(`dispute ${event.data.object.id}: respond before the deadline`);
      break;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      console.log(`subscription ${event.data.object.id} is ${event.data.object.status}`);
      break;
    case 'invoice.payment_failed':
      console.log(`invoice ${event.data.object.id} failed`);
      break;
    case 'connected_account.updated':
      // `event.account` names the seller on every event about one.
      console.log(`seller ${event.data.object.external_ref} payable=${event.data.object.payable}`);
      break;
    default:
      // Subscribe your endpoint only to what you handle (`enabled_events`).
      console.log(`ignored ${event.type}`);
  }
}

Bun.serve({
  port: PORT,
  routes: { '/webhooks': { POST: receive } },
  fetch: () => new Response('Not found', { status: 404 }),
  error(error) {
    console.error(error);
    return new Response('internal error', { status: 500 });
  },
});

console.log(`Receiving webhooks on http://localhost:${PORT}/webhooks`);
