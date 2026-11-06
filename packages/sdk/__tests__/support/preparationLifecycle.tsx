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
mock.module('react-native', () => ({
  Platform: { OS: 'web' },
  Linking: { openURL: async () => {} },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
mock.module('@oxy.so/bloom/button', () => ({ Button: () => null }));
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
      return {
        ...publicSessionFixture,
        id: 'cs_0123456789abcdef01234567',
        customer_details: { ...publicSessionFixture.customer_details, email: 'payer@example.test' },
      };
    },
  }),
}));
const { PeableSheetCheckout } = await import('../../src/ui/PeableSheetCheckout');
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
async function render(preparation: SheetCheckoutPreparation) {
  await act(async () => {
    root.render(
      createElement(PeableSheetCheckout, {
        preparation,
        onSettled: () => {},
        onUnavailable: (reason) => {
          throw new Error(reason);
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
await render({
  key: 'account-a:cart-b',
  request,
  initialDetails: { email: 'old@example.test', selectedAddressId: 'address-1' },
  createSession: async (details) => {
    attempts.push(details);
    if (attempts.length === 1) throw new Error('network lost');
    return retry.promise;
  },
});
await act(async () => {
  getFields().onContinue();
});
assert.equal(getFields().disabled, true);
await act(async () => {
  getFields().onChange({ ...getFields().details, email: 'changed@example.test' });
});
assert.equal(getFields().details.email, 'old@example.test');
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
await act(async () => root.unmount());
await window.happyDOM.close();
console.log('Checkout preparation lifecycle: passed');
