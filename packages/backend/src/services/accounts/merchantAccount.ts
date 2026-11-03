/**
 * The merchant's OWN fiat account (ADR 0015 §1) — `GET/POST /v1/account`.
 *
 * Generalises the seller onboarding in `connectedAccountService.ts` rather than
 * copying it: the same provider account (Accounts v2), the same snapshot table
 * (`connected_accounts`, `role = 'merchant'`), the same refresh and the same
 * readiness events — with no provider dashboard (Orbit is the only one the
 * merchant sees) and no `external_ref` (the merchant needs no id for itself).
 *
 * KYC is collected by the provider through its hosted onboarding link; no
 * identity document ever reaches this database.
 */
import { randomUUID } from 'node:crypto';
import type { UpdateAccountParams } from '@peable.to/shared-types';
import {
  findMerchantAccount,
  hasCardHalf,
  insertMerchantAccount,
  type CardConnectedAccountRow,
} from '../../db/accounts/connectedAccountRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { getDb } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { assertLiveMoneyAllowed } from '../money/chargeRouting';
import { isAccountConfiguringProvider, type ProviderAccountUpdate } from '../providers/provider';
import {
  AccountsUnavailableError,
  applyProviderSnapshot,
  requireDefaultAccountProvider,
  requireProviderFor,
} from './connectedAccountService';

/** The merchant has no fiat account yet, and the request cannot open one. 404 `account_missing`. */
export class AccountMissingError extends Error {
  constructor(message = 'this merchant has no fiat account; open one with POST /v1/account') {
    super(message);
    this.name = 'AccountMissingError';
  }
}

/** A field that only opening the account takes (country, business type). 400. */
export class AccountImmutableFieldError extends Error {
  constructor(readonly param: string) {
    super(`${param} is fixed once the account is open`);
    this.name = 'AccountImmutableFieldError';
  }
}

/** The settings half of an update, in the port's vocabulary. */
export function toProviderUpdate(params: UpdateAccountParams): ProviderAccountUpdate | null {
  const settings = params.settings;
  const schedule = settings?.payouts?.schedule;
  const update: ProviderAccountUpdate = {
    ...(params.business_profile ? { businessProfile: params.business_profile } : {}),
    ...(schedule
      ? {
          payoutSchedule: {
            interval: schedule.interval,
            ...(schedule.delay_days !== undefined ? { delayDays: schedule.delay_days } : {}),
            ...(schedule.weekly_anchor !== undefined
              ? { weeklyAnchor: schedule.weekly_anchor }
              : {}),
            ...(schedule.monthly_anchor !== undefined
              ? { monthlyAnchor: schedule.monthly_anchor }
              : {}),
          },
        }
      : {}),
    ...(settings?.payouts?.statement_descriptor !== undefined
      ? { payoutStatementDescriptor: settings.payouts.statement_descriptor }
      : {}),
    ...(settings?.payments?.statement_descriptor !== undefined
      ? { paymentsStatementDescriptor: settings.payments.statement_descriptor }
      : {}),
    ...(settings?.branding?.primary_color !== undefined
      ? { brandingPrimaryColor: settings.branding.primary_color }
      : {}),
    ...(settings?.branding?.secondary_color !== undefined
      ? { brandingSecondaryColor: settings.branding.secondary_color }
      : {}),
  };
  return Object.keys(update).length === 0 ? null : update;
}

/**
 * Open the merchant's own account at the provider, then apply any settings the
 * same request carried. Converges: a second open (a retry, a race) presents the
 * same provider idempotency key and lands on the same account.
 *
 * @throws {ThirdPartyLiveGateError} a live account for a non-Oxy merchant behind the gate.
 */
export async function openMerchantAccount(
  merchant: MerchantRow,
  params: UpdateAccountParams & { country: string; business_type: 'individual' | 'company' },
): Promise<{ account: CardConnectedAccountRow; created: boolean }> {
  assertLiveMoneyAllowed(merchant, 'a fiat account');
  const db = getDb();
  const existing = await findMerchantAccount(db, merchant.id);
  if (existing && hasCardHalf(existing)) return { account: existing, created: false };

  const provider = requireDefaultAccountProvider(merchant.environment);
  const country = params.country.toUpperCase();
  const snapshot = await provider.createAccount({
    accountId: `${merchant.id}:merchant`,
    country,
    businessType: params.business_type,
    // Derived from the merchant, never random: a provider account cannot be
    // deleted, and a retry must find the one it already opened.
    idempotencyKey: `acct:merchant:${merchant.id}`,
    metadata: { peable_merchant_id: merchant.id },
    role: 'merchant',
  });
  const inserted =
    (await insertMerchantAccount(db, {
      publicId: newId('ca'),
      merchantId: merchant.id,
      provider: provider.id,
      providerAccountId: snapshot.providerAccountId,
      country,
    })) ?? (await findMerchantAccount(db, merchant.id));
  if (!inserted || !hasCardHalf(inserted)) {
    throw new Error(`merchant account for ${merchant.publicId} neither inserted nor found`);
  }
  const stored = await applyProviderSnapshot(inserted, snapshot);
  const update = toProviderUpdate(params);
  const account = update ? await updateAccountSettings(asCard(stored), update) : asCard(stored);
  return { account, created: true };
}

/** Write settings to the provider and store what it reads back (with its event). */
export async function updateAccountSettings(
  account: CardConnectedAccountRow,
  update: ProviderAccountUpdate,
): Promise<CardConnectedAccountRow> {
  const provider = requireProviderFor(account);
  if (!isAccountConfiguringProvider(provider)) {
    throw new AccountsUnavailableError(`the ${provider.id} rail cannot configure accounts`);
  }
  // A fresh key per write: an update is idempotent by its content, and a
  // content-derived key would make A → B → A replay the first answer and
  // leave the account at B. The request's own Idempotency-Key covers retries.
  const key = `acct_update:${account.publicId}:${randomUUID()}`;
  const snapshot = await provider.updateAccount(account.providerAccountId, update, key);
  return asCard(await applyProviderSnapshot(account, snapshot));
}

function asCard(row: Awaited<ReturnType<typeof applyProviderSnapshot>>): CardConnectedAccountRow {
  if (!hasCardHalf(row)) throw new Error(`account ${row.publicId} lost its card half`);
  return row;
}
