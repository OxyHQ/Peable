/**
 * Orbit's application fees as the provider took them (ADR 0015 §3).
 *
 * The fee is INSTRUCTED on the payment (`application_fee_amount`) and TAKEN by
 * the provider when the charge succeeds; this module records what the provider
 * reports it took — never the instruction — and the refunds of it, each with
 * its event in the same transaction.
 */
import {
  findAccountByProviderAccountId,
  findAccountForOnboarding,
} from '../../db/accounts/connectedAccountRepository';
import {
  findFeeByProviderObject,
  insertApplicationFee,
  insertFeeRefund,
  listFeeRefunds,
  type ApplicationFeeRow,
} from '../../db/money/applicationFeeRepository';
import { findIntentByProviderCharge } from '../../db/payments/paymentIntentRepository';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { toApplicationFeeDTO } from '../../lib/serializeMoney';
import { recordEvent } from '../events';
import type { ProviderId } from '../providers/provider';
import { kickWebhookOutbox } from '../webhookOutbox';
import { requireMirroringProvider } from './ledger';

async function recordFeeEvent(
  tx: DatabaseOrTransaction,
  type: 'application_fee.created' | 'application_fee.refunded',
  fee: ApplicationFeeRow,
): Promise<void> {
  const refunds = await listFeeRefunds(tx, fee.id);
  await recordEvent(tx, {
    merchantId: fee.merchantId,
    type,
    object: toApplicationFeeDTO(fee, refunds),
    account: fee.connectedAccountPublicId,
  });
}

/**
 * A provider `application_fee.*` event: re-read the fee and record it and any
 * refunds not yet recorded. `unmatched` while its charge is not yet bound to a
 * payment here (the drain retries).
 */
export async function handleApplicationFeeEvent(
  provider: ProviderId,
  livemode: boolean,
  providerFeeId: string,
): Promise<'applied' | 'unmatched'> {
  const adapter = requireMirroringProvider(provider, livemode);
  const fee = await adapter.getApplicationFee(providerFeeId);
  const db = getDb();
  const intent = fee.chargeObjectId
    ? await findIntentByProviderCharge(db, provider, fee.chargeObjectId)
    : null;
  if (!intent) return 'unmatched';
  // The account it was taken from: the destination the payment recorded, or
  // the one the provider names.
  const account = intent.transferDestinationId
    ? await findAccountForOnboarding(db, intent.transferDestinationId)
    : fee.accountObjectId
      ? await findAccountByProviderAccountId(db, provider, fee.accountObjectId)
      : null;
  if (!account || account.merchantId !== intent.merchantId) return 'unmatched';

  await db.transaction(async (tx) => {
    const { fee: row, created } = await insertApplicationFee(tx, {
      publicId: newId('fee'),
      merchantId: intent.merchantId,
      paymentIntentId: intent.id,
      connectedAccountId: account.id,
      amount: fee.amount,
      currency: fee.currency,
      provider,
      providerObjectId: fee.providerObjectId,
    });
    if (created) await recordFeeEvent(tx, 'application_fee.created', row);
    let refunded = false;
    for (const refund of fee.refunds) {
      const inserted = await insertFeeRefund(tx, {
        publicId: newId('fr'),
        applicationFeeId: row.id,
        amount: refund.amount,
        currency: refund.currency,
        provider,
        providerObjectId: refund.providerObjectId,
        createdAt: refund.created,
      });
      refunded ||= inserted;
    }
    if (refunded) {
      const current = await findFeeByProviderObject(tx, provider, fee.providerObjectId);
      if (current) await recordFeeEvent(tx, 'application_fee.refunded', current);
    }
  });
  kickWebhookOutbox();
  return 'applied';
}
