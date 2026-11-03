import { expect, test } from 'bun:test';
import { voidUnpaidInitialInvoice } from './stripeTestInvoiceCancellation';
test('does not void a paid or active subscription invoice', async () => {
  for (const state of [
    { invoiceStatus: 'paid', subscriptionStatus: 'active' },
    { invoiceStatus: 'open', subscriptionStatus: 'active' },
  ]) {
    let writes = 0;
    await voidUnpaidInitialInvoice(
      state,
      async () => {
        writes++;
      },
      async () => {
        throw new Error('unnecessary read');
      },
    );
    expect(writes).toBe(0);
  }
});
test('voids only the unpaid initial incomplete invoice', async () => {
  let writes = 0;
  await voidUnpaidInitialInvoice(
    { invoiceStatus: 'open', subscriptionStatus: 'incomplete' },
    async () => {
      writes++;
    },
    async () => {
      throw new Error('unnecessary read');
    },
  );
  expect(writes).toBe(1);
});
test('payment winning void race is reread and preserved, not canceled', async () => {
  let reads = 0;
  await voidUnpaidInitialInvoice(
    { invoiceStatus: 'open', subscriptionStatus: 'incomplete' },
    async () => {
      throw new Error('already paid');
    },
    async () => {
      reads++;
      return { invoiceStatus: 'paid', subscriptionStatus: 'active' };
    },
  );
  expect(reads).toBe(1);
});
test('unresolved cancellation fails closed', async () => {
  await expect(
    voidUnpaidInitialInvoice(
      { invoiceStatus: 'open', subscriptionStatus: 'incomplete' },
      async () => {
        throw new Error('outage');
      },
      async () => ({ invoiceStatus: 'open', subscriptionStatus: 'incomplete' }),
    ),
  ).rejects.toThrow('unresolved');
});
