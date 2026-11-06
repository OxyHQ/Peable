import type { CheckoutSessionPublic } from '@peable.to/shared-types';
// Isolated process: presentation mocks and DOM globals must never leak into headless SDK tests.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { PeableCheckoutSheetProps } from '../../src/ui/PeableCheckoutSheet';
import type {
  SheetCheckoutPreparation,
  SheetCheckoutDetails,
  SheetPreparedCheckout,
} from '../../src/ui/checkoutPreparation';
import type { CheckoutPreparationFields } from '../../src/ui/CheckoutPreparationFields';
import type { ComponentProps } from 'react';
import { publicSessionFixture } from './checkoutFixture';

const window = new Window();
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});
let sheet: PeableCheckoutSheetProps | undefined;
let fields: ComponentProps<typeof CheckoutPreparationFields> | undefined;
let mounts = 0;
let unmounts = 0;
let reads = 0;
let payerSession: CheckoutSessionPublic = {
  ...publicSessionFixture,
  id: 'cs_0123456789abcdef01234567',
  customer_details: { ...publicSessionFixture.customer_details, email: 'payer@example.test' },
};
let readBlock: Promise<void> | undefined;
let updateBlock: Promise<void> | undefined;
const updates: { id: string; secret: string; body: { customer_details: { email: string } } }[] = [];
const unavailable: string[] = [];
mock.module('react-native', () => ({
  Platform: { OS: 'web' },
  Linking: { openURL: async () => {} },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
let regionField: { value: string; onChangeText(value: string): void } | undefined;
let billingContinue: { disabled?: boolean; onPress?(): void } | undefined;
mock.module('@oxy.so/bloom/text-field', () => ({
  TextFieldInput: (props: typeof regionField) => {
    regionField = props;
    return null;
  },
}));
mock.module('@oxy.so/bloom/button', () => ({
  Button: (props: typeof billingContinue) => {
    billingContinue = props;
    return null;
  },
}));
mock.module('@oxy.so/bloom/card-form', () => ({
  CardFormCountry: () => null,
  CardFormPostcode: () => null,
}));
mock.module('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
mock.module('@oxy.so/bloom/typography', () => ({ Text: () => null }));
mock.module('../../src/ui/PeableCheckoutSheet', () => ({
  PeableCheckoutSheet: (props: PeableCheckoutSheetProps) => {
    sheet = props;
    useEffect(() => {
      mounts++;
      return () => {
        unmounts++;
      };
    }, []);
    return createElement('div', { 'data-sheet': true }, props.methodContent);
  },
}));
mock.module('../../src/ui/CheckoutPreparationFields', () => ({
  CheckoutPreparationFields: (props: ComponentProps<typeof CheckoutPreparationFields>) => {
    fields = props;
    return null;
  },
}));
mock.module('../../src/ui/PeableProviderFields', () => ({ PeableProviderFields: () => null }));
mock.module('../../src/ui/PeableWalletButtons', () => ({ PeableWalletButtons: () => null }));
mock.module('../../src/browser/payerClient', () => ({
  createPeableCheckout: () => ({
    getCheckoutSession: async () => {
      reads++;
      const response = payerSession;
      await readBlock;
      return response;
    },
    updateCheckoutSession: async (
      id: string,
      secret: string,
      body: { customer_details: { email: string } },
    ) => {
      updates.push({ id, secret, body });
      await updateBlock;
      payerSession = {
        ...payerSession,
        customer_details: { ...payerSession.customer_details, ...body.customer_details },
      };
      return payerSession;
    },
  }),
}));
const { PeableSheetCheckout, SHEET_POLL_MS } = await import('../../src/ui/PeableSheetCheckout');
const nativeSetInterval = globalThis.setInterval;
let poll: () => void = () => {
  throw new Error('poll not installed');
};
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  if (args[1] === SHEET_POLL_MS && typeof args[0] === 'function') {
    const callback = args[0];
    poll = () => callback();
  }
  return nativeSetInterval(...args);
}) as typeof setInterval;
const { SheetPreparationError } = await import('../../src/ui/checkoutPreparation');

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('not initialized');
  };
  let reject: (error: Error) => void = () => {
    throw new Error('not initialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const result: SheetPreparedCheckout = {
  source: {
    type: 'checkout_session',
    id: 'cs_0123456789abcdef01234567',
    clientSecret: 'cs_0123456789abcdef01234567_secret_0123456789abcdef',
  },
  expected: { amount: '3000', currency: 'EUR', livemode: false },
};
const request = {
  merchant: 'Fixture',
  currency: 'EUR',
  dueTodayMinorUnits: 3000,
  items: [],
  requiresShipping: false,
  requiresContact: false,
  paymentMethods: ['card', 'faircoin'],
};
let root = createRoot(document.createElement('div'));
function getFields() {
  assert.ok(fields);
  return fields;
}
function getSheet() {
  assert.ok(sheet);
  return sheet;
}
async function render(preparation: SheetCheckoutPreparation, open = true) {
  await act(async () => {
    root.render(
      createElement(PeableSheetCheckout, {
        preparation,
        open,
        onSettled: () => {},
        onUnavailable: (reason) => {
          unavailable.push(reason);
        },
        onClose: () => {},
      }),
    );
  });
}
async function reset() {
  await act(async () => root.unmount());
  root = createRoot(document.createElement('div'));
  fields = undefined;
  sheet = undefined;
}

// Opening mounts a real sheet without creating or reading an order; duplicate Continue is guarded.
let calls = 0;
const first = deferred<SheetPreparedCheckout>();
await render({
  key: 'account-a:cart-a',
  request,
  createSession: async () => {
    calls++;
    return first.promise;
  },
});
assert.equal(calls, 0);
assert.equal(reads, 0);
assert.equal(mounts, 1);
await act(async () => {
  getSheet().onStep('payment');
});
await act(async () => {
  getFields().onContinue();
  getFields().onContinue();
});
assert.equal(calls, 1);
assert.equal(getFields().disabled, true);
await act(async () => {
  first.resolve(result);
  await first.promise;
});
assert.equal(reads, 1);
assert.equal(mounts, 1);
assert.equal(unmounts, 0);
assert.equal(getSheet().step, 'review');
assert.equal(getSheet().request.dueTodayMinorUnits, 2700);
await reset();

// An ambiguous response freezes the same object across retries, including selected address metadata.
const attempts: Readonly<SheetCheckoutDetails>[] = [];
const retry = deferred<SheetPreparedCheckout>();
const retryPreparation: SheetCheckoutPreparation = {
  key: 'account-a:cart-b',
  request,
  initialDetails: { email: 'old@example.test', selectedAddressId: 'address-1' },
  createSession: async (details) => {
    attempts.push(details);
    if (attempts.length === 1)
      throw new SheetPreparationError('The merchant needs attention', 'unknown');
    return retry.promise;
  },
};
await render(retryPreparation);
await act(async () => {
  getFields().onContinue();
});
assert.equal(getFields().disabled, true);
await render(retryPreparation, false);
assert.equal(getSheet().open, false);
await render(retryPreparation, true);
assert.equal(getSheet().open, true);
assert.equal(getFields().disabled, true);
await act(async () => {
  getFields().onChange({ ...getFields().details, email: 'changed@example.test' });
});
assert.equal(getFields().details.email, 'old@example.test');
assert.equal(getFields().error, 'The merchant needs attention');
await act(async () => {
  getFields().onContinue();
});
assert.equal(attempts.length, 2);
assert.equal(attempts[0], attempts[1]);
assert.ok(Object.isFrozen(attempts[0]?.shipping));
retry.resolve(result);
await act(async () => {
  await retry.promise;
});
await reset();

// A proven pre-creation refusal unlocks correction; a new callback receives corrected details.
const corrected: Readonly<SheetCheckoutDetails>[] = [];
await render({
  key: 'account-a:cart-c',
  request,
  initialDetails: { email: 'first@example.test' },
  createSession: async (details) => {
    corrected.push(details);
    throw new SheetPreparationError('Fix address', 'not_created');
  },
});
await act(async () => {
  getFields().onContinue();
});
assert.equal(getFields().disabled, false);
await act(async () => {
  getFields().onChange({ ...getFields().details, email: 'corrected@example.test' });
});
await act(async () => {
  getFields().onContinue();
});
assert.equal(corrected[1]?.email, 'corrected@example.test');
await reset();

// Account defaults arriving after immediate open prefill pristine fields, never overwrite edits.
const asynchronousDefaults: SheetCheckoutPreparation = {
  key: 'account-a:cart-defaults',
  request,
  createSession: async () => result,
};
await render(asynchronousDefaults);
assert.equal(getFields().details.email, '');
await render({ ...asynchronousDefaults, initialDetails: { email: 'account@example.test' } });
assert.equal(getFields().details.email, 'account@example.test');
await act(async () => {
  getFields().onChange({ ...getFields().details, email: 'edited@example.test' });
});
await render({ ...asynchronousDefaults, initialDetails: { email: 'later@example.test' } });
assert.equal(getFields().details.email, 'edited@example.test');
await reset();

// Account/cart identity changes abort stale preparation, clear private fields and ignore late success.
const stale = deferred<SheetPreparedCheckout>();
let signal: AbortSignal | undefined;
await render({
  key: 'account-a:cart-d',
  request,
  initialDetails: { email: 'private@example.test' },
  createSession: async (_details, context) => {
    signal = context.signal;
    return stale.promise;
  },
});
await act(async () => {
  getFields().onContinue();
});
const readsBefore = reads;
await render({ key: 'account-b:cart-d', request, createSession: async () => result });
assert.equal(signal?.aborted, true);
assert.equal(getFields().details.email, '');
await act(async () => {
  stale.resolve(result);
  await stale.promise;
});
assert.equal(reads, readsBefore);
assert.equal(getSheet().frameKey, 'preparation');
await reset();
// A guest enters email once: the same mounted checkout collects it on the payer session.
assert.deepEqual(unavailable, []);
payerSession = {
  ...payerSession,
  customer_details: { ...payerSession.customer_details, email: null },
};
await render({
  key: 'guest:contact',
  request: { ...request, requiresContact: true },
  createSession: async () => result,
});
await act(async () => {
  getFields().onChange({ ...getFields().details, email: 'guest@example.test' });
});
await act(async () => {
  getFields().onContinue();
  getFields().onContinue();
});
assert.deepEqual(updates, [
  {
    id: result.source.id,
    secret: result.source.clientSecret,
    body: { customer_details: { email: 'guest@example.test' } },
  },
]);
assert.equal(getSheet().request.requiresContact, false);
await reset();

// An account channel never sends a hidden email, even if account defaults contain one.
payerSession = {
  ...payerSession,
  contact_collection: 'merchant_account',
  customer_details: { ...payerSession.customer_details, email: null },
};
await render({
  key: 'account:contact',
  request,
  initialDetails: { email: 'account@example.test' },
  createSession: async () => result,
});
await act(async () => {
  getFields().onContinue();
});
assert.equal(updates.length, 1);
assert.equal(getSheet().request.requiresContact, false);
await reset();

// No private contact is sent when the returned order fails the host's reviewed price.
payerSession = { ...payerSession, contact_collection: 'email', amount_subtotal: '99999' };
await render({
  key: 'guest:mismatch',
  request,
  initialDetails: { email: 'private@example.test' },
  createSession: async () => result,
});
await act(async () => {
  getFields().onContinue();
});
assert.equal(updates.length, 1);
assert.deepEqual(unavailable, ['mismatch']);
await reset();
payerSession = { ...payerSession, amount_subtotal: '3000' };

// GET may finish after unmount or an account switch: neither may initiate a private UPDATE.
for (const scenario of ['unmount', 'account-switch']) {
  const delayed = deferred<void>();
  readBlock = delayed.promise;
  await render({
    key: `guest:${scenario}`,
    request,
    initialDetails: { email: 'private@example.test' },
    createSession: async () => result,
  });
  await act(async () => {
    getFields().onContinue();
  });
  if (scenario === 'unmount') await reset();
  else await render({ key: 'new-account:cart', request, createSession: async () => result });
  await act(async () => {
    delayed.resolve(undefined);
    await delayed.promise;
  });
  assert.equal(updates.length, 1);
  readBlock = undefined;
  await reset();
}
// Empty subscription prerequisites stay on review: Continue creates only the order.
const emptyAttempt = deferred<SheetPreparedCheckout>();
const emptyDetails: Readonly<SheetCheckoutDetails>[] = [];
payerSession = { ...payerSession, contact_collection: 'merchant_account' };
await render({
  key: 'account:empty',
  request,
  createSession: async (details) => {
    emptyDetails.push(details);
    if (emptyDetails.length === 1) return emptyAttempt.promise;
    return result;
  },
});
assert.equal(emptyDetails.length, 0);
await act(async () => {
  getSheet().onStep('method');
});
assert.equal(emptyDetails.length, 1);
assert.equal(getSheet().step, 'review');
assert.equal(getSheet().brandState, 'loading');
assert.equal(getSheet().continueDisabled, true);
await act(async () => {
  emptyAttempt.reject(new SheetPreparationError('Retry this order', 'unknown'));
});
assert.equal(getSheet().step, 'review');
assert.equal(getSheet().notice, 'Retry this order');
assert.equal(getSheet().continueDisabled, false);
await act(async () => {
  getSheet().onStep('method');
});
assert.equal(emptyDetails.length, 2);
assert.equal(emptyDetails[0], emptyDetails[1]);
assert.equal(getSheet().step, 'review');
await reset();

// Real prerequisites still get their details screen, including merchant-specific consent.
for (const required of ['contact', 'shipping', 'additional']) {
  let created = 0;
  await render({
    key: `account:required:${required}`,
    request: {
      ...request,
      requiresContact: required === 'contact',
      requiresShipping: required === 'shipping',
    },
    ...(required === 'additional'
      ? { renderAdditionalDetails: () => createElement('span', null, 'Consent') }
      : {}),
    createSession: async () => {
      created++;
      return result;
    },
  });
  await act(async () => {
    getSheet().onStep('method');
  });
  assert.equal(getSheet().step, 'method');
  assert.equal(created, 0);
  await reset();
}
let blockedCreates = 0;
await render({
  key: 'account:blocked',
  request,
  canContinue: false,
  createSession: async () => {
    blockedCreates++;
    return result;
  },
});
assert.equal(getSheet().continueDisabled, true);
await act(async () => {
  getSheet().onStep('method');
});
assert.equal(blockedCreates, 0);
await reset();
payerSession = { ...payerSession, contact_collection: 'email' };

// Overlapping polls share only the in-flight contact write; later reads retain fresh totals.
const baselineUpdates = updates.length;
const slowUpdate = deferred<void>();
updateBlock = slowUpdate.promise;
payerSession = {
  ...payerSession,
  customer_details: { ...payerSession.customer_details, email: null },
};
await render({
  key: 'guest:overlap',
  request,
  initialDetails: { email: 'guest@example.test' },
  createSession: async () => result,
});
await act(async () => {
  getFields().onContinue();
});
assert.equal(updates.length, baselineUpdates + 1);
await act(async () => {
  poll();
});
assert.equal(updates.length, baselineUpdates + 1);
await act(async () => {
  slowUpdate.resolve(undefined);
  await slowUpdate.promise;
});
updateBlock = undefined;
assert.equal(getSheet().request.dueTodayMinorUnits, 2700);
payerSession = {
  ...payerSession,
  amount_total: '2500',
  customer_details: { ...payerSession.customer_details, email: null },
};
await act(async () => {
  poll();
});
assert.equal(updates.length, baselineUpdates + 2);
assert.equal(getSheet().request.dueTodayMinorUnits, 2500);
await reset();
// A reviewed, unchanged total advances to method selection, never authorization.
for (const scenario of [
  'unchanged',
  'repriced',
  'currency',
  'contact',
  'shipping',
  'paid',
  'unsupported',
] as const) {
  payerSession = {
    ...publicSessionFixture,
    id: result.source.id,
    amount_total: scenario === 'repriced' ? '3200' : '3000',
    contact_collection: scenario === 'contact' ? 'email' : 'merchant_account',
    payment_status: scenario === 'paid' ? 'paid' : 'unpaid',
    shipping_address_collection: scenario === 'shipping' ? { allowed_countries: ['US'] } : null,
    phone_number_collection: { enabled: scenario === 'unsupported' },
  };
  const beforeUpdates: number = updates.length;
  const beforeMounts: number = mounts;
  let created = 0;
  await render({
    key: `advance:${scenario}`,
    request: { ...request, currency: scenario === 'currency' ? 'USD' : 'EUR' },
    createSession: async () => {
      created++;
      return result;
    },
  });
  assert.equal(created, 0);
  await act(async () => {
    getSheet().onStep('method');
  });
  assert.equal(created, 1);
  assert.equal(mounts, beforeMounts + 1);
  assert.equal(updates.length, beforeUpdates);
  if (scenario !== 'paid')
    assert.equal(getSheet().step, scenario === 'unchanged' ? 'payment' : 'review', scenario);
  assert.notEqual(getSheet().step, 'card');
  assert.notEqual(getSheet().step, 'confirmation');
  await reset();
}
// US/CA tax cannot continue with just country and postcode; record the payer's region.
for (const country of ['US', 'CA']) {
  payerSession = {
    ...publicSessionFixture,
    id: result.source.id,
    contact_collection: 'merchant_account',
    automatic_tax: { enabled: true, status: 'requires_location_inputs' },
    customer_details: {
      ...publicSessionFixture.customer_details,
      address: { line1: null, line2: null, city: null, country, state: null, postal_code: '19802' },
    },
  };
  await render({ key: `billing:${country}`, request, createSession: async () => result });
  await act(async () => {
    getSheet().onStep('method');
  });
  await act(async () => {
    getSheet().onStep('card');
  });
  assert.ok(regionField);
  assert.equal(regionField.value, '');
  assert.equal(billingContinue?.disabled, true);
  await act(async () => {
    regionField?.onChangeText(country === 'US' ? 'DE' : 'ON');
  });
  assert.equal(billingContinue?.disabled, false);
  await act(async () => {
    billingContinue?.onPress?.();
  });
  assert.deepEqual(updates.at(-1)?.body, {
    customer_details: {
      address: { country, postal_code: '19802', state: country === 'US' ? 'DE' : 'ON' },
    },
  });
  await reset();
}
// Explicit shipping reuse preserves region and never asks the payer to retype it.
payerSession = {
  ...publicSessionFixture,
  id: result.source.id,
  contact_collection: 'merchant_account',
  automatic_tax: { enabled: true, status: 'requires_location_inputs' },
  customer_details: { ...publicSessionFixture.customer_details, address: null },
};
await render({
  key: 'billing:shipping',
  request: { ...request, requiresShipping: true },
  initialDetails: {
    shipping: {
      name: 'Alex',
      line1: '10 Example Street',
      line2: '',
      city: 'Wilmington',
      state: 'DE',
      postalCode: '19802',
      country: 'US',
      phone: '',
    },
  },
  createSession: async () => result,
});
await act(async () => {
  getSheet().onStep('method');
});
await act(async () => {
  getFields().onChange({ ...getFields().details, useShippingForBilling: true });
});
await act(async () => {
  getFields().onContinue();
});
await act(async () => {
  getSheet().onStep('card');
});
assert.equal(regionField?.value, 'DE');
assert.equal(billingContinue?.disabled, false);
await act(async () => {
  billingContinue?.onPress?.();
});
assert.deepEqual(updates.at(-1)?.body, {
  customer_details: { address: { country: 'US', postal_code: '19802', state: 'DE' } },
});
await reset();
globalThis.setInterval = nativeSetInterval;
await act(async () => root.unmount());
await window.happyDOM.close();
console.log('Checkout preparation lifecycle: passed');
