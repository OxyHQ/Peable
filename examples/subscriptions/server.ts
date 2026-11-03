import {
  PeableError,
  PeableSignatureVerificationError,
  type Subscription,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEvent,
} from '@peable.to/sdk';
import { FEATURE_LOOKUP_KEY, PRICE_LOOKUP_KEY, peable, required } from './peable';

const PORT = Number(process.env.PORT ?? 4242);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
// The endpoint's `whsec_…`, or the one `peable listen` prints for its session.
const WEBHOOK_SECRET = required('PEABLE_WEBHOOK_SECRET');

// Stand-in for your app's own sign-in: a browser session owns ONE customer.
// Never let a request name the customer it acts for — the portal it opens
// can cancel that customer's subscriptions and change their card.
const customerBySession = new Map<string, string>();
const SESSION_COOKIE = 'sid';

function signedInCustomer(request: Bun.BunRequest): string | null {
  const sid = request.cookies.get(SESSION_COOKIE);
  return sid ? (customerBySession.get(sid) ?? null) : null;
}

async function subscribe(request: Bun.BunRequest): Promise<Response> {
  const email = String((await request.formData()).get('email') ?? '').trim();
  if (!email.includes('@')) return page('Subscribe', '<p>Enter an email address.</p>', 400);

  let sid = request.cookies.get(SESSION_COOKIE);
  let customer = sid ? customerBySession.get(sid) : undefined;
  if (sid && customer) {
    // Already subscribed: a plan change is the portal's, not a second subscription.
    const { data } = await peable.subscriptions.list({ customer, limit: 10 });
    const live = data.some((sub) => !['canceled', 'incomplete_expired'].includes(sub.status));
    if (live) return Response.redirect(`${BASE_URL}/account`, 303);
  } else {
    sid = crypto.randomUUID();
    customer = (await peable.customers.create({ email }, { idempotencyKey: `customer:${sid}` })).id;
    customerBySession.set(sid, customer);
  }

  const [price] = (await peable.prices.list({ lookup_keys: [PRICE_LOOKUP_KEY], active: true }))
    .data;
  if (!price) throw new Error(`no active price "${PRICE_LOOKUP_KEY}": run \`bun run setup\``);

  // The hosted page collects the card, creates the subscription and its first
  // (taxed) invoice, and saves the card for renewals. The subscription is
  // `active` once that first payment succeeds — not when the payer returns.
  const session = await peable.checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: `${BASE_URL}/account?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/`,
  });
  if (!session.url) throw new Error('a hosted session always has a url');
  return new Response(null, {
    status: 303,
    headers: {
      location: session.url,
      'set-cookie': `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/`,
    },
  });
}

async function account(request: Bun.BunRequest): Promise<Response> {
  const customer = signedInCustomer(request);
  if (!customer) return Response.redirect(`${BASE_URL}/`, 303);

  // Read live from Peable. Access is the ACTIVE ENTITLEMENTS, not a status
  // you cached: they follow trials, renewals, dunning and cancellations.
  const [subscriptions, entitlements] = await Promise.all([
    peable.subscriptions.list({ customer, limit: 10 }),
    peable.entitlements.activeEntitlements.list({ customer }),
  ]);
  const hasPro = entitlements.data.some((e) => e.lookup_key === FEATURE_LOOKUP_KEY);

  const rows = subscriptions.data.map((sub) => `<li>${describe(sub)}</li>`).join('');
  const starting =
    new URL(request.url).searchParams.has('session_id') && !hasPro
      ? '<p>Your subscription starts once the first payment succeeds. Refresh in a moment.</p>'
      : '';
  return page(
    'Your account',
    `${starting}<p>Pro features: <strong>${hasPro ? 'on' : 'off'}</strong></p>` +
      `<ul>${rows || '<li>No subscriptions yet.</li>'}</ul>` +
      '<form method="post" action="/portal"><button>Manage billing</button></form>',
  );
}

async function portal(request: Bun.BunRequest): Promise<Response> {
  const customer = signedInCustomer(request);
  if (!customer) return Response.redirect(`${BASE_URL}/`, 303);
  // A one-hour link for this customer only: mint it on click, never store or email it.
  const session = await peable.billingPortal.sessions.create({
    customer,
    return_url: `${BASE_URL}/account`,
  });
  return Response.redirect(session.url, 303);
}

async function webhook(request: Request): Promise<Response> {
  const signature = request.headers.get(WEBHOOK_SIGNATURE_HEADER);
  const body = await request.text(); // the raw bytes the signature covers
  if (!signature) return new Response('missing signature', { status: 400 });

  let event: WebhookEvent;
  try {
    event = peable.webhooks.constructEvent(body, signature, WEBHOOK_SECRET);
  } catch (error) {
    if (error instanceof PeableSignatureVerificationError) {
      return new Response('bad signature', { status: 400 });
    }
    throw error;
  }

  switch (event.type) {
    // Events can arrive out of order: re-read the subscription, then act on
    // what it is now rather than on what this event carried.
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      const sub = await peable.subscriptions.retrieve(event.data.object.id);
      console.log(`subscription ${sub.id} is ${sub.status}`);
      break;
    }
    case 'customer.subscription.trial_will_end':
      console.log(`remind ${customerOf(event.data.object)}: the trial ends in three days`);
      break;
    case 'invoice.paid':
      console.log(`invoice ${event.data.object.id} paid: send the receipt`);
      break;
    // Dunning retries on its own schedule; tell the customer so they can fix their card.
    case 'invoice.payment_failed':
      console.log(`invoice ${event.data.object.id} failed: ask the customer to update their card`);
      break;
    case 'invoice.payment_action_required':
      console.log(
        `invoice ${event.data.object.id} needs the customer: send ${event.data.object.hosted_invoice_url}`,
      );
      break;
    // Grant or withdraw access here: the summary is the customer's entitlements now.
    case 'entitlements.active_entitlement_summary.updated': {
      const { customer, entitlements } = event.data.object;
      const hasPro = entitlements.data.some((e) => e.lookup_key === FEATURE_LOOKUP_KEY);
      console.log(`customer ${customer}: Pro features ${hasPro ? 'on' : 'off'}`);
      break;
    }
  }
  return Response.json({ received: true });
}

function customerOf(sub: Subscription): string {
  return typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
}

function describe(sub: Subscription): string {
  const renews = new Date(sub.current_period_end * 1000).toLocaleDateString('en');
  const ending = sub.cancel_at_period_end ? `ends ${renews}` : `renews ${renews}`;
  return `${sub.id}: ${sub.status}, ${ending}`;
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body><h1>${title}</h1>${body}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function home(request: Bun.BunRequest): Response {
  const signedIn = signedInCustomer(request) !== null;
  return page(
    'Pro — 9.00 EUR a month',
    (signedIn ? '<p><a href="/account">Your account</a></p>' : '') +
      '<form method="post" action="/subscribe">' +
      '<input type="email" name="email" placeholder="you@example.com" required> ' +
      '<button>Subscribe</button></form>',
  );
}

Bun.serve({
  port: PORT,
  routes: {
    '/': home,
    '/subscribe': { POST: subscribe },
    '/account': { GET: account },
    '/portal': { POST: portal },
    '/webhooks': { POST: webhook },
  },
  fetch: () => new Response('Not found', { status: 404 }),
  error(error) {
    console.error(error);
    const detail = error instanceof PeableError ? ` (${error.code ?? error.type})` : '';
    return new Response(`Something went wrong${detail}`, { status: 500 });
  },
});

console.log(`Subscriptions on ${BASE_URL}`);
