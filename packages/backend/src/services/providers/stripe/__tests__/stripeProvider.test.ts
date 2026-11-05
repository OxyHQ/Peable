/**
 * The Stripe adapter, against a FAKE Stripe client.
 *
 * Fake rather than mocked-per-test: every call goes through `client.ts`, and
 * `mock.module` replaces it for the whole file, so the adapter runs unchanged
 * and the assertions are about what it ASKED Stripe for. That is the half a
 * sandbox cannot check cheaply and the half that is expensive to get wrong —
 * an idempotency key in the wrong argument position, a missing
 * `source_transaction`, an amount that does not survive the round trip.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

interface Recorded {
  readonly fn: string;
  /** The mode the adapter called in — every client call takes it first (ADR 0017). */
  readonly mode: unknown;
  readonly args: readonly unknown[];
}

const calls: Recorded[] = [];
let paymentIntentResponse: Record<string, unknown> = {};
let refundResponse: Record<string, unknown> = {};
let transferResponse: Record<string, unknown> = {};
/** What `retrieveStripeTransfer` answers, when the adapter has to ask. */
let retrievedTransferResponse: Record<string, unknown> = {};
let accountResponse: Record<string, unknown> = {};
let disputeResponse: Record<string, unknown> = {};
let domainResponse: Record<string, unknown> = {};
/** What the expanded settlement reads answer: a charge, a refund, a dispute. */
let chargeWithBalanceResponse: Record<string, unknown> = {};
let refundWithBalanceResponse: Record<string, unknown> = {};
let disputeWithBalancesResponse: Record<string, unknown> = {};

function record(fn: string, [mode, ...args]: readonly unknown[]) {
  calls.push({ fn, mode, args });
}

mock.module('../client', () => ({
  STRIPE_API_VERSION: '2026-07-29.dahlia',
  getStripeClient: () => {
    throw new Error('the adapter must not reach the SDK directly');
  },
  resetStripeClient: () => undefined,
  retrieveStripeChargeWithBalance: async (...args: unknown[]) => {
    record('retrieveStripeChargeWithBalance', args);
    return chargeWithBalanceResponse;
  },
  retrieveStripeRefundWithBalance: async (...args: unknown[]) => {
    record('retrieveStripeRefundWithBalance', args);
    return refundWithBalanceResponse;
  },
  retrieveStripeDisputeWithBalances: async (...args: unknown[]) => {
    record('retrieveStripeDisputeWithBalances', args);
    return disputeWithBalancesResponse;
  },
  updateStripeDispute: async (...args: unknown[]) => {
    record('updateStripeDispute', args);
    return disputeResponse;
  },
  retrieveStripeDispute: async (...args: unknown[]) => {
    record('retrieveStripeDispute', args);
    return disputeResponse;
  },
  closeStripeDispute: async (...args: unknown[]) => {
    record('closeStripeDispute', args);
    return { ...disputeResponse, status: 'lost' };
  },
  createStripeDisputeFile: async (...args: unknown[]) => {
    record('createStripeDisputeFile', args);
    return { id: 'file_stripe_1' };
  },
  createStripePaymentMethodConfiguration: async (...args: unknown[]) => {
    record('createStripePaymentMethodConfiguration', args);
    return { id: 'pmc_stripe_1' };
  },
  updateStripePaymentMethodConfiguration: async (...args: unknown[]) => {
    record('updateStripePaymentMethodConfiguration', args);
    return { id: args[1] };
  },
  createStripePaymentMethodDomain: async (...args: unknown[]) => {
    record('createStripePaymentMethodDomain', args);
    return domainResponse;
  },
  updateStripePaymentMethodDomain: async (...args: unknown[]) => {
    record('updateStripePaymentMethodDomain', args);
    return domainResponse;
  },
  validateStripePaymentMethodDomain: async (...args: unknown[]) => {
    record('validateStripePaymentMethodDomain', args);
    return domainResponse;
  },
  toProviderError: (error: unknown) => error,
  createStripePaymentIntent: async (...args: unknown[]) => {
    record('createStripePaymentIntent', args);
    return paymentIntentResponse;
  },
  retrieveStripePaymentIntent: async (...args: unknown[]) => {
    record('retrieveStripePaymentIntent', args);
    return paymentIntentResponse;
  },
  cancelStripePaymentIntent: async (...args: unknown[]) => {
    record('cancelStripePaymentIntent', args);
    return paymentIntentResponse;
  },
  captureStripePaymentIntent: async (...args: unknown[]) => {
    record('captureStripePaymentIntent', args);
    return paymentIntentResponse;
  },
  createStripeRefund: async (...args: unknown[]) => {
    record('createStripeRefund', args);
    return refundResponse;
  },
  retrieveStripeRefund: async (...args: unknown[]) => {
    record('retrieveStripeRefund', args);
    return refundResponse;
  },
  createStripeTransfer: async (...args: unknown[]) => {
    record('createStripeTransfer', args);
    return transferResponse;
  },
  createStripeTransferReversal: async (...args: unknown[]) => {
    record('createStripeTransferReversal', args);
    return transferResponse;
  },
  retrieveStripeTransfer: async (...args: unknown[]) => {
    record('retrieveStripeTransfer', args);
    return retrievedTransferResponse;
  },
  createStripeConnectedAccountV2: async (...args: unknown[]) => {
    record('createStripeConnectedAccountV2', args);
    return { id: 'acct_new' };
  },
  retrieveStripeAccount: async (...args: unknown[]) => {
    record('retrieveStripeAccount', args);
    return accountResponse;
  },
  createStripeAccountLink: async (...args: unknown[]) => {
    record('createStripeAccountLink', args);
    return { url: 'https://connect.stripe.com/setup/e/x', expires_at: 1_700_000_300 };
  },
  constructStripeEvent: async () => ({
    id: 'evt_1',
    type: 'payment_intent.succeeded',
    livemode: false,
    api_version: '2026-07-29.dahlia',
    data: { object: { id: 'pi_1', object: 'payment_intent' } },
  }),
  cancelStripeSetupIntent: async () => {
    throw new Error('not used by these tests');
  },
  confirmStripePaymentIntent: async () => {
    throw new Error('not used by these tests');
  },
  createStripeSetupIntent: async () => {
    throw new Error('not used by these tests');
  },
  detachStripePaymentMethod: async () => {
    throw new Error('not used by these tests');
  },
  retrieveStripePaymentMethod: async () => {
    throw new Error('not used by these tests');
  },
  retrieveStripeSetupIntent: async () => {
    throw new Error('not used by these tests');
  },
  createStripeCustomer: async () => {
    throw new Error('not used by these tests');
  },
  retrieveStripeCharge: async () => {
    throw new Error('not used by these tests');
  },
  // Every other export the adapter imports, so this file also runs on its own:
  // a module mock missing a named import fails the whole file at link time.
  cancelStripeRefund: async () => {
    throw new Error('not used by these tests');
  },
  listStripeBalanceTransactions: async () => {
    throw new Error('not used by these tests');
  },
  retrieveStripeChargeWithLedger: async () => {
    throw new Error('not used by these tests');
  },
  retrieveStripePayout: async () => {
    throw new Error('not used by these tests');
  },
  listStripePayouts: async () => {
    throw new Error('not used by these tests');
  },
  createStripePayout: async () => {
    throw new Error('not used by these tests');
  },
  cancelStripePayout: async () => {
    throw new Error('not used by these tests');
  },
  retrieveStripeApplicationFee: async () => {
    throw new Error('not used by these tests');
  },
  updateStripeAccount: async () => {
    throw new Error('not used by these tests');
  },
}));

const { StripePaymentProvider } = await import('../stripeProvider');
const { ProviderError } = await import('../../provider');

function argsOf(fn: string): readonly unknown[] {
  const call = calls.find((entry) => entry.fn === fn);
  if (!call) throw new Error(`${fn} was never called`);
  return call.args;
}

describe('StripePaymentProvider', () => {
  beforeEach(() => {
    calls.length = 0;
    disputeResponse = {
      id: 'du_1',
      status: 'warning_needs_response',
      is_charge_refundable: true,
      evidence_details: { has_evidence: true, submission_count: 0 },
      evidence: { customer_name: 'Jane Buyer', receipt: 'file_stripe_9', billing_address: '' },
    };
    domainResponse = {
      id: 'pmd_stripe_1',
      enabled: true,
      apple_pay: { status: 'inactive', status_details: { error_message: 'provider prose' } },
      google_pay: { status: 'active' },
    };
    paymentIntentResponse = {
      id: 'pi_1',
      status: 'requires_payment_method',
      client_secret: 'pi_1_secret_x',
    };
    refundResponse = { id: 're_1', status: 'succeeded' };
    transferResponse = { id: 'tr_1', reversed: false, amount: 500 };
    accountResponse = {
      id: 'acct_1',
      payouts_enabled: false,
      capabilities: { transfers: 'pending' },
      requirements: { currently_due: ['business_profile.url'], past_due: [] },
      default_currency: 'eur',
    };
  });

  test('sends every call through the client of its OWN mode', async () => {
    // ADR 0017: the adapter is bound to one mode for its life, and the mode is
    // the first argument of every client call — a live adapter can never reach
    // the test client, nor the reverse.
    const live = new StripePaymentProvider({ mode: 'live' });
    await live.createPayment({
      intentId: 'pi_live_1',
      amount: { amount: '100', currency: 'EUR' },
      idempotencyKey: 'pay:pi_live_1',
      metadata: {},
    });
    await live.getStatus('pi_1');
    await new StripePaymentProvider({ mode: 'test' }).getStatus('pi_2');
    expect(calls.map((call) => [call.fn, call.mode])).toEqual([
      ['createStripePaymentIntent', 'live'],
      ['retrieveStripePaymentIntent', 'live'],
      ['retrieveStripePaymentIntent', 'test'],
    ]);
  });

  test("creates a payment with the gateway's intent id in metadata and transfer_group", async () => {
    const provider = new StripePaymentProvider({ mode: 'test' });
    const result = await provider.createPayment({
      intentId: 'pi_public_1',
      amount: { amount: '2500', currency: 'EUR' },
      idempotencyKey: 'pay:pi_public_1',
      metadata: { order: 'A-1' },
    });

    const [params, idempotencyKey] = argsOf('createStripePaymentIntent') as [
      Record<string, unknown>,
      string,
    ];
    expect(params.automatic_payment_methods).toEqual({ enabled: true });
    expect(params.allowed_payment_method_types).toBeUndefined();
    expect(params.amount).toBe(2500);
    // Lowercase: Stripe's ISO code, not the gateway's uppercase set.
    expect(params.currency).toBe('eur');
    expect(params.transfer_group).toBe('pi_public_1');
    expect(params.metadata).toMatchObject({ order: 'A-1', peable_intent_id: 'pi_public_1' });
    expect(idempotencyKey).toBe('pay:pi_public_1');

    expect(result.providerObjectId).toBe('pi_1');
    expect(result.status).toBe('requires_payment_method');
    expect(result.clientAction).toEqual({ kind: 'client_secret', value: 'pi_1_secret_x' });
  });

  test('pins an immutable integration method allowlist without changing the dynamic default', async () => {
    const methods: Array<'card'> = ['card'];
    const provider = new StripePaymentProvider({
      mode: 'test',
      allowedPaymentMethodTypes: methods,
    });
    methods.length = 0;
    await provider.createPayment({
      intentId: 'pi_card_entry',
      amount: { amount: '599', currency: 'USD' },
      idempotencyKey: 'pay:pi_card_entry',
      metadata: {},
    });
    const [params] = argsOf('createStripePaymentIntent') as [Record<string, unknown>];
    expect(params.allowed_payment_method_types).toEqual(['card']);
    expect(params.automatic_payment_methods).toBeUndefined();
    expect(params.payment_method_types).toBeUndefined();
  });

  test('selects one integration configuration without a conflicting allowlist', async () => {
    const provider = new StripePaymentProvider({
      mode: 'test',
      paymentMethodConfiguration: 'pmc_local',
    });
    await provider.createPayment({
      intentId: 'pi_configured',
      amount: { amount: '599', currency: 'USD' },
      idempotencyKey: 'pay:pi_configured',
      metadata: {},
    });
    const [params] = argsOf('createStripePaymentIntent') as [Record<string, unknown>];
    expect(params.payment_method_configuration).toBe('pmc_local');
    expect(params.automatic_payment_methods).toEqual({ enabled: true });
    expect(params.allowed_payment_method_types).toBeUndefined();
    expect(
      () =>
        new StripePaymentProvider({
          mode: 'test',
          paymentMethodConfiguration: 'pmc_local',
          allowedPaymentMethodTypes: ['card'],
        }),
    ).toThrow('either');
  });

  /**
   * The amount guard.
   *
   * Stripe counts in a JS `number`; the gateway carries an unbounded integer
   * string. Above `Number.MAX_SAFE_INTEGER` the conversion silently rounds —
   * a real charge for an amount nobody authorised. Refusing is the only safe
   * direction, and it is refused as PERMANENT because no retry makes the
   * number representable.
   */
  test('refuses an amount that cannot survive the conversion to a Stripe amount', async () => {
    const provider = new StripePaymentProvider({ mode: 'test' });
    const attempt = provider.createPayment({
      intentId: 'pi_public_2',
      amount: { amount: '9007199254740993', currency: 'EUR' },
      idempotencyKey: 'pay:pi_public_2',
      metadata: {},
    });

    await expect(attempt).rejects.toThrow(ProviderError);
    await expect(attempt).rejects.toMatchObject({ retryable: false });
    expect(calls.find((entry) => entry.fn === 'createStripePaymentIntent')).toBeUndefined();
  });

  /**
   * Capture on a rail that already captured.
   *
   * `paymentIntents.capture` on an already-captured intent is an ERROR, not a
   * no-op — so "call it anyway for symmetry" turns a settled payment into a
   * failure. Reading it back is the honest action.
   */
  test('capture reads back rather than re-capturing an already captured payment', async () => {
    paymentIntentResponse = { id: 'pi_1', status: 'succeeded', client_secret: 's' };
    const provider = new StripePaymentProvider({ mode: 'test' });

    const result = await provider.capture({
      intentId: 'pi_public_1',
      providerObjectId: 'pi_1',
      idempotencyKey: 'cap:pi_public_1',
    });

    expect(result.status).toBe('succeeded');
    expect(calls.find((entry) => entry.fn === 'captureStripePaymentIntent')).toBeUndefined();
  });

  test('capture does capture when the payment is genuinely awaiting it', async () => {
    paymentIntentResponse = { id: 'pi_1', status: 'requires_capture', client_secret: 's' };
    const provider = new StripePaymentProvider({ mode: 'test' });

    await provider.capture({
      intentId: 'pi_public_1',
      providerObjectId: 'pi_1',
      idempotencyKey: 'cap:pi_public_1',
    });

    expect(argsOf('captureStripePaymentIntent')).toEqual(['pi_1', {}, 'cap:pi_public_1']);
  });

  /** A partial capture (ADR 0019) sends Stripe's `amount_to_capture` as a number. */
  test('capture sends amount_to_capture for a partial capture', async () => {
    paymentIntentResponse = { id: 'pi_1', status: 'requires_capture', client_secret: 's' };
    const provider = new StripePaymentProvider({ mode: 'test' });

    await provider.capture({
      intentId: 'pi_public_1',
      providerObjectId: 'pi_1',
      idempotencyKey: 'cap:pi_public_1',
      amountToCapture: '1500',
    });

    expect(argsOf('captureStripePaymentIntent')).toEqual([
      'pi_1',
      { amount_to_capture: 1500 },
      'cap:pi_public_1',
    ]);
  });

  /**
   * `source_transaction` is what makes the transfer WAIT for the charge's
   * funds. Without it a transfer created moments after a charge fails with
   * `balance_insufficient` against a platform whose money is real but not yet
   * available — an intermittent failure that looks like a Stripe outage.
   *
   * It takes a CHARGE id, which is why the request field is
   * `sourceChargeObjectId`. This test always passed a `ch_…` and the caller
   * always supplied a `pi_…`: the adapter is not where the substitution
   * happened, so no assertion here could have caught it. The name is now the
   * type's documentation, and `transferService` resolves the charge before it
   * calls.
   */
  test('a transfer names its source transaction and its group', async () => {
    const provider = new StripePaymentProvider({ mode: 'test' });
    await provider.createTransfer({
      intentId: 'pi_public_1',
      transferId: 'tr_gateway_1',
      sourceChargeObjectId: 'ch_1',
      destinationAccountId: 'acct_seller',
      amount: { amount: '500', currency: 'EUR' },
      groupRef: 'group_1',
      idempotencyKey: 'tr:tr_gateway_1',
      metadata: {},
    });

    const [params, key] = argsOf('createStripeTransfer') as [Record<string, unknown>, string];
    expect(params.source_transaction).toBe('ch_1');
    expect(params.destination).toBe('acct_seller');
    expect(params.transfer_group).toBe('group_1');
    expect(params.amount).toBe(500);
    expect(key).toBe('tr:tr_gateway_1');
  });

  /**
   * The CUMULATIVE reversed total, read off the transfer.
   *
   * A caller deciding whether a transfer is fully reversed must not have to add
   * up reversals it may not have all seen — so reporting this leg's amount
   * would make a second partial reversal look like the first.
   */
  test('a reversal reports the cumulative total when Stripe expanded it', async () => {
    transferResponse = {
      id: 'trr_1',
      amount: 200,
      transfer: { id: 'tr_1', amount_reversed: 500 },
    };
    const provider = new StripePaymentProvider({ mode: 'test' });

    const result = await provider.reverseTransfer({
      transferId: 'tr_gateway_1',
      transferObjectId: 'tr_1',
      amount: { amount: '200', currency: 'EUR' },
      idempotencyKey: 'trr:tr_gateway_1',
      metadata: {},
    });

    expect(result.totalReversed).toBe('500');
    // Nothing was re-read: the expansion already carried the answer.
    expect(calls.filter((entry) => entry.fn === 'retrieveStripeTransfer')).toHaveLength(0);
  });

  /**
   * ...and RE-READS the transfer when Stripe did not expand it, which is the
   * normal case.
   *
   * `createReversal` does not expand `transfer`, so the expanded branch above
   * was the exceptional one and the FALLBACK was the path every real reversal
   * took. That fallback was `String(reversal.amount)` — this leg. Stored by
   * `applyTransferReversal` as the cumulative total, and guarded there on the
   * new total being no SMALLER than the stored one, so reversing 500 and then
   * 500 again left `amount_reversed` at 500: the transfer never reached
   * `reversed` and the seller kept half of what had been taken back.
   *
   * The test that existed asserted only the expanded branch, so it agreed with
   * the adapter and could not see the defect.
   */
  test('a reversal re-reads the transfer when Stripe did not expand it', async () => {
    transferResponse = { id: 'trr_2', amount: 500, transfer: 'tr_2' };
    retrievedTransferResponse = { id: 'tr_2', amount_reversed: 1000 };
    const provider = new StripePaymentProvider({ mode: 'test' });

    const result = await provider.reverseTransfer({
      transferId: 'tr_gateway_2',
      transferObjectId: 'tr_2',
      amount: { amount: '500', currency: 'EUR' },
      idempotencyKey: 'trr:trr_gateway_2',
      metadata: {},
    });

    // 1000, the cumulative figure — NOT the 500 this leg reversed.
    expect(result.totalReversed).toBe('1000');
    expect(argsOf('retrieveStripeTransfer')).toEqual(['tr_2']);
  });

  /**
   * ADR 0008 D2-C and D2-D are ONE decision. `card_payments` is requested
   * beside transfers because Stripe refuses the pair otherwise outside the US,
   * AND because a recipient-only v2 account never emits `account.updated` —
   * the only readiness trigger there is. This test exists so removing the
   * "unnecessary" capability is a red build rather than a six-hour delay that a
   * demo passes.
   */
  test('account creation requests card_payments alongside transfers', async () => {
    const provider = new StripePaymentProvider({ mode: 'test' });
    await provider.createAccount({
      accountId: 'acc_gateway_1',
      country: 'ES',
      businessType: 'individual',
      idempotencyKey: 'acct:acc_gateway_1',
      metadata: {},
      role: 'seller',
    });

    const [body] = argsOf('createStripeConnectedAccountV2') as [Record<string, unknown>];
    const configuration = body.configuration as Record<string, Record<string, unknown>>;
    expect(configuration.merchant?.capabilities).toMatchObject({
      card_payments: { requested: true },
    });
    expect(configuration.recipient?.capabilities).toMatchObject({
      stripe_balance: { stripe_transfers: { requested: true } },
    });
    expect(body.dashboard).toBe('express');
    expect((body.defaults as Record<string, unknown>).responsibilities).toMatchObject({
      losses_collector: 'application',
      fees_collector: 'application',
    });
  });

  /**
   * The v2 create carries none of the readiness fields, so a snapshot built
   * from its response would report an account with no capabilities and no
   * requirements — indistinguishable from one that is genuinely blocked.
   */
  test('account creation reads the account back through the v1 API', async () => {
    const provider = new StripePaymentProvider({ mode: 'test' });
    const snapshot = await provider.createAccount({
      accountId: 'acc_gateway_1',
      country: 'ES',
      businessType: 'company',
      idempotencyKey: 'acct:acc_gateway_1',
      metadata: {},
      role: 'seller',
    });

    expect(argsOf('retrieveStripeAccount')).toEqual(['acct_new']);
    expect(snapshot.payoutsEnabled).toBe(false);
    expect(snapshot.transfersCapability).toBe('pending');
    expect(snapshot.currentlyDue).toEqual(['business_profile.url']);
    expect(snapshot.defaultCurrency).toBe('EUR');
  });

  /**
   * `eventually_due`, not `currently_due`. Otherwise a seller completes
   * onboarding, starts selling, and has payouts interrupted weeks later by a
   * requirement that was always coming.
   */
  test('an onboarding link collects eventually-due requirements', async () => {
    const provider = new StripePaymentProvider({ mode: 'test' });
    const link = await provider.accountLink({
      providerAccountId: 'acct_1',
      refreshUrl: 'https://gateway.example/refresh',
      returnUrl: 'https://gateway.example/return',
    });

    const [params] = argsOf('createStripeAccountLink') as [Record<string, unknown>];
    expect(params.type).toBe('account_onboarding');
    expect(params.collection_options).toMatchObject({ fields: 'eventually_due' });
    expect(link.url).toContain('connect.stripe.com');
    expect(link.expiresAt).toBeInstanceOf(Date);
  });

  describe('payment method breadth and disputes', () => {
    test('named types are sent as payment_method_types; a configuration as its binding', async () => {
      const provider = new StripePaymentProvider({ mode: 'test' });
      await provider.createPayment({
        intentId: 'pi_named',
        amount: { amount: '1500', currency: 'JPY' },
        idempotencyKey: 'pay:pi_named',
        metadata: {},
        paymentMethodTypes: ['card', 'ideal'],
      });
      const [named] = argsOf('createStripePaymentIntent') as [Record<string, unknown>];
      expect(named.payment_method_types).toEqual(['card', 'ideal']);
      expect(named.automatic_payment_methods).toBeUndefined();
      // A zero-decimal currency crosses as the same integer.
      expect(named.amount).toBe(1500);
      expect(named.currency).toBe('jpy');

      calls.length = 0;
      await provider.createPayment({
        intentId: 'pi_configured',
        amount: { amount: '2500', currency: 'EUR' },
        idempotencyKey: 'pay:pi_configured',
        metadata: {},
        paymentMethodConfigurationObjectId: 'pmc_stripe_merchant',
      });
      const [configured] = argsOf('createStripePaymentIntent') as [Record<string, unknown>];
      expect(configured.automatic_payment_methods).toEqual({ enabled: true });
      expect(configured.payment_method_configuration).toBe('pmc_stripe_merchant');
      expect(configured.payment_method_types).toBeUndefined();
    });

    test('a configuration names Orbit’s methods and switches every other one off', async () => {
      const provider = new StripePaymentProvider({ mode: 'test' });
      const created = await provider.savePaymentMethodConfiguration({
        configurationId: 'pmc_orbit_1',
        methods: { card: 'on', apple_pay: 'on', sepa_debit: 'off' },
        idempotencyKey: 'pmc:pmc_orbit_1:stripe:v1',
      });
      expect(created.providerObjectId).toBe('pmc_stripe_1');
      const [params, key] = argsOf('createStripePaymentMethodConfiguration') as [
        Record<string, { display_preference: { preference: string } }>,
        string,
      ];
      expect(params.card?.display_preference.preference).toBe('on');
      expect(params.sepa_debit?.display_preference.preference).toBe('off');
      expect(params.link?.display_preference.preference).toBe('off');
      expect(params.klarna?.display_preference.preference).toBe('off');
      expect(key).toBe('pmc:pmc_orbit_1:stripe:v1');

      await provider.savePaymentMethodConfiguration({
        providerObjectId: 'pmc_stripe_1',
        configurationId: 'pmc_orbit_1',
        methods: { card: 'off' },
        idempotencyKey: 'pmc:pmc_orbit_1:stripe:v2',
      });
      const [id] = argsOf('updateStripePaymentMethodConfiguration') as [string];
      expect(id).toBe('pmc_stripe_1');
    });

    test('evidence crosses in Stripe’s names, text and files, and comes back without file ids', async () => {
      const provider = new StripePaymentProvider({ mode: 'test' });
      const snapshot = await provider.updateDisputeEvidence({
        providerObjectId: 'du_1',
        evidence: { customer_name: 'Jane Buyer', receipt: 'file_stripe_9', billing_address: '' },
        submit: true,
        idempotencyKey: 'dpev:dp_1',
      });
      const [id, params, key] = argsOf('updateStripeDispute') as [
        string,
        { evidence: Record<string, string>; submit: boolean },
        string,
      ];
      expect(id).toBe('du_1');
      expect(params.submit).toBe(true);
      expect(params.evidence).toEqual({
        customer_name: 'Jane Buyer',
        receipt: 'file_stripe_9',
        billing_address: '',
      });
      expect(key).toBe('dpev:dp_1');
      expect(snapshot.status).toBe('needs_response');
      expect(snapshot.hasEvidence).toBe(true);
      expect(snapshot.isChargeRefundable).toBe(true);
      expect(snapshot.evidence.customer_name).toBe('Jane Buyer');
      expect(snapshot.evidence.billing_address).toBeNull();
      expect('receipt' in snapshot.evidence).toBe(false);

      const closed = await provider.closeDispute({ providerObjectId: 'du_1', idempotencyKey: 'k' });
      expect(closed.status).toBe('lost');
      const uploaded = await provider.uploadDisputeEvidenceFile({
        bytes: new Uint8Array([1, 2, 3]),
        filename: 'r.pdf',
        mime: 'application/pdf',
        idempotencyKey: 'dpfile:dp_1:receipt:file_1',
      });
      expect(uploaded.providerFileId).toBe('file_stripe_1');
      const [file, fileKey] = argsOf('createStripeDisputeFile') as [
        Record<string, unknown>,
        string,
      ];
      expect(file.name).toBe('r.pdf');
      expect(fileKey).toBe('dpfile:dp_1:receipt:file_1');
    });

    test('a domain’s wallet standing is in Peable’s words, never the provider’s prose', async () => {
      const provider = new StripePaymentProvider({ mode: 'test' });
      const domain = await provider.createPaymentMethodDomain({
        domainName: 'shop.example.com',
        enabled: true,
        idempotencyKey: 'pmd:merch_1:shop.example.com',
      });
      expect(domain.applePay.status).toBe('inactive');
      expect(domain.applePay.error).not.toContain('provider prose');
      expect(domain.applePay.error).toContain('Apple Pay');
      expect(domain.googlePay).toEqual({ status: 'active', error: null });
    });
  });
});

/**
 * One movement of the settlement balance each — a payment, a refund, a
 * dispute — in one set of signs: `gross` the magnitude, `fee` and `net` as
 * Stripe signs them (`net = amount − fee`). No balance transaction is
 * `unknown`, never zeros.
 */
describe('StripePaymentProvider settlement', () => {
  /** A Stripe balance transaction, settled in EUR unless a test says otherwise. */
  function balance(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'txn_1',
      object: 'balance_transaction',
      status: 'available',
      currency: 'eur',
      available_on: 1_793_750_400,
      exchange_rate: null,
      ...fields,
    };
  }

  beforeEach(() => {
    calls.length = 0;
  });

  test("a payment's figures are its charge's balance transaction", async () => {
    chargeWithBalanceResponse = {
      id: 'ch_1',
      balance_transaction: balance({ amount: 10_000, fee: 204, net: 9_796 }),
    };

    const settlement = await new StripePaymentProvider({ mode: 'live' }).getSettlement('ch_1');

    expect(settlement).toEqual({
      status: 'available',
      gross: '10000',
      fee: '204',
      net: '9796',
      currency: 'EUR',
      availableOn: new Date(1_793_750_400_000),
      exchangeRate: null,
    });
    expect(calls).toEqual([
      { fn: 'retrieveStripeChargeWithBalance', mode: 'live', args: ['ch_1'] },
    ]);
  });

  test('a refund reports its own debit: gross the magnitude, net negative', async () => {
    refundWithBalanceResponse = {
      id: 're_stripe_1',
      status: 'succeeded',
      balance_transaction: balance({ amount: -1_000, fee: 0, net: -1_000, status: 'pending' }),
    };

    const settlement = await new StripePaymentProvider({ mode: 'test' }).getRefundSettlement(
      're_stripe_1',
    );

    expect(settlement).toEqual({
      status: 'pending',
      gross: '1000',
      fee: '0',
      net: '-1000',
      currency: 'EUR',
      availableOn: new Date(1_793_750_400_000),
      exchangeRate: null,
    });
    expect(calls).toEqual([
      { fn: 'retrieveStripeRefundWithBalance', mode: 'test', args: ['re_stripe_1'] },
    ]);
  });

  /**
   * A refund of a payment presented in USD and settled in EUR moves EUR: the
   * figure a marketplace books, at the rate the provider applied.
   */
  test('a converted refund is in the settlement currency, with the rate', async () => {
    refundWithBalanceResponse = {
      id: 're_stripe_2',
      status: 'succeeded',
      currency: 'usd',
      amount: 1_000,
      balance_transaction: balance({
        amount: -921,
        fee: 0,
        net: -921,
        currency: 'eur',
        exchange_rate: 0.921,
      }),
    };

    const settlement = await new StripePaymentProvider({ mode: 'test' }).getRefundSettlement(
      're_stripe_2',
    );

    expect(settlement.currency).toBe('EUR');
    expect(settlement.gross).toBe('921');
    expect(settlement.net).toBe('-921');
    expect(settlement.exchangeRate).toBe(0.921);
  });

  /** A fee the provider RETURNED on a refund is a negative fee: `net = −gross − fee`. */
  test('a fee returned on a refund is negative and shrinks the debit', async () => {
    refundWithBalanceResponse = {
      id: 're_stripe_3',
      status: 'succeeded',
      balance_transaction: balance({ amount: -1_000, fee: -30, net: -970 }),
    };

    const settlement = await new StripePaymentProvider({ mode: 'test' }).getRefundSettlement(
      're_stripe_3',
    );

    expect([settlement.gross, settlement.fee, settlement.net]).toEqual(['1000', '-30', '-970']);
  });

  test('a refund with no balance transaction yet is unknown, not zero', async () => {
    refundWithBalanceResponse = { id: 're_stripe_4', status: 'pending', balance_transaction: null };

    const settlement = await new StripePaymentProvider({ mode: 'test' }).getRefundSettlement(
      're_stripe_4',
    );

    expect(settlement).toEqual({
      status: 'unknown',
      gross: null,
      fee: null,
      net: null,
      currency: null,
      availableOn: null,
      exchangeRate: null,
    });
  });

  /**
   * A failed refund's debit is undone by a second transaction: its own figure
   * is money that came back, and booking it would book a refund that never
   * happened.
   */
  test('a refund that failed took nothing in the end: unknown', async () => {
    refundWithBalanceResponse = {
      id: 're_stripe_5',
      status: 'failed',
      balance_transaction: balance({ amount: -1_000, fee: 0, net: -1_000 }),
      failure_balance_transaction: 'txn_back',
    };

    const settlement = await new StripePaymentProvider({ mode: 'test' }).getRefundSettlement(
      're_stripe_5',
    );

    expect(settlement.status).toBe('unknown');
    expect(settlement.net).toBeNull();
  });

  test('a dispute reports its WITHDRAWAL: the principal and the dispute fee', async () => {
    disputeWithBalancesResponse = {
      id: 'du_1',
      status: 'won',
      balance_transactions: [
        // Stripe lists them in order; the reinstatement of a won dispute is
        // the later, positive one and is not this figure.
        balance({ id: 'txn_out', amount: -5_000, fee: 1_500, net: -6_500 }),
        balance({ id: 'txn_back', amount: 5_000, fee: 0, net: 5_000 }),
      ],
    };

    const settlement = await new StripePaymentProvider({ mode: 'live' }).getDisputeSettlement(
      'du_1',
    );

    expect(settlement).toEqual({
      status: 'available',
      gross: '5000',
      fee: '1500',
      net: '-6500',
      currency: 'EUR',
      availableOn: new Date(1_793_750_400_000),
      exchangeRate: null,
    });
    expect(calls).toEqual([
      { fn: 'retrieveStripeDisputeWithBalances', mode: 'live', args: ['du_1'] },
    ]);
  });

  /** An inquiry moves no money: no balance transaction, every figure `null`. */
  test('an inquiry with no balance transaction is unknown, not zero', async () => {
    disputeWithBalancesResponse = {
      id: 'du_2',
      status: 'warning_needs_response',
      balance_transactions: [],
    };

    const settlement = await new StripePaymentProvider({ mode: 'test' }).getDisputeSettlement(
      'du_2',
    );

    expect(settlement).toEqual({
      status: 'unknown',
      gross: null,
      fee: null,
      net: null,
      currency: null,
      availableOn: null,
      exchangeRate: null,
    });
  });
});
