import { billingFinalInvoiceAuthoritySchema } from '@peable.to/contracts';
import type { BillingTaxCheckoutSnapshot } from './tax-checkout';
import { createPublicKey, verify } from 'node:crypto';
import {
  canonicalBillingAuthority,
  type BillingFinalInvoiceAuthority,
  type BillingPaidInvoice,
} from '@peable.to/shared-types';
import { BillingError, type BillingOwner } from './contracts';
import { toUnix } from '../../lib/time';

export interface FinalInvoiceAuthorityReader {
  /** Trusted deployment adapter; never constructed from merchant request data. */
  read(input: {
    owner: BillingOwner;
    merchantPublicId: string;
    invoice: BillingPaidInvoice;
    taxCheckoutSnapshot?: BillingTaxCheckoutSnapshot;
    /** Present only when the caller asked for the frozen tax lines. */
    include?: { taxLines: true };
  }): Promise<unknown>;
  /** Pinned issuer verification keys. No key is accepted from a response. */
  verificationKeys: Readonly<Record<string, string>>;
  /** Peable itself signs, so it may put its own frozen tax lines inside the
   * signature. A reader relaying someone else's signature never can. */
  signsTaxLines?: boolean;
}

export function verifyFinalInvoiceAuthority(
  raw: unknown,
  expected: { owner: BillingOwner; merchantPublicId: string; invoice: BillingPaidInvoice },
  keys: Readonly<Record<string, string>>,
  now: Date,
): BillingFinalInvoiceAuthority {
  const authority = billingFinalInvoiceAuthoritySchema.parse(raw);
  const { source, invoice, signature } = authority;
  const paid = expected.invoice;
  const context = invoice.context;
  const clock = toUnix(now);
  if (
    source.invoice_id !== paid.invoice_id ||
    source.payment_intent_id !== paid.payment_intent_id ||
    source.customer_id !== paid.provider_customer_id ||
    source.subscription_id !== paid.provider_subscription_id ||
    source.price_id !== paid.provider_price_id ||
    source.plan_id !== paid.plan_id ||
    source.merchant_id !== expected.merchantPublicId ||
    source.app_id !== expected.owner.oxyAppId ||
    source.environment !== expected.owner.environment ||
    (source.mode === 'live') !== paid.livemode ||
    context.mode !== source.mode ||
    context.environment !== source.environment ||
    context.provider_subscription_id !== source.subscription_id ||
    context.payer_account_id !== paid.store_id ||
    context.beneficiary_account_id !== paid.store_id ||
    context.period_start !== paid.period_start ||
    context.period_end !== paid.period_end ||
    context.period_end <= context.period_start ||
    invoice.currency !== paid.currency ||
    BigInt(invoice.gross_minor_units) !== BigInt(paid.amount_paid) ||
    paid.net_amount === null ||
    paid.tax_amount === null ||
    BigInt(invoice.net_minor_units) !== BigInt(paid.net_amount) ||
    BigInt(invoice.tax_minor_units) !== BigInt(paid.tax_amount) ||
    invoice.net_minor_units + invoice.tax_minor_units !== invoice.gross_minor_units ||
    (invoice.tax_lines !== undefined &&
      invoice.tax_lines.reduce((sum, line) => sum + line.tax_minor_units, 0) !==
        invoice.tax_minor_units) ||
    !Number.isSafeInteger(invoice.net_minor_units + invoice.tax_minor_units) ||
    invoice.issued_at > clock ||
    invoice.expires_at <= clock ||
    invoice.expires_at <= invoice.issued_at ||
    paid.paid_at > clock ||
    paid.observed_at > clock ||
    clock - paid.observed_at > 60
  )
    throw new BillingError('invalid_provider_response', 502);
  const fx = invoice.faircoin_quote;
  if (
    authority.method === 'faircoin' &&
    (!fx ||
      fx.quoted_at > clock ||
      fx.expires_at > invoice.expires_at ||
      paid.paid_at < fx.quoted_at ||
      paid.paid_at >= fx.expires_at ||
      fx.expires_at <= fx.quoted_at)
  )
    throw new BillingError('invalid_provider_response', 502);
  const pinnedKey = Object.hasOwn(keys, signature.key_id) ? keys[signature.key_id] : undefined;
  if (!pinnedKey) throw new BillingError('invalid_provider_response', 502);
  try {
    const key = createPublicKey(pinnedKey);
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      !verify(
        null,
        Buffer.from(canonicalBillingAuthority(authority), 'utf8'),
        key,
        Buffer.from(signature.value, 'base64url'),
      )
    )
      throw new Error('Signature differs');
  } catch {
    throw new BillingError('invalid_provider_response', 502);
  }
  return authority;
}
