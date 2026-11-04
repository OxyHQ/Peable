import { createHash } from 'node:crypto';
import { EXPLORER_BASE_URL } from '@fairco.in/core';
import { type BillingFaircoinFxQuote, isBaseUnitString } from '@peable.to/shared-types';
import { BillingError } from './contracts';
import { toUnix } from '../../lib/time';

export type FaircoinFxQuote = BillingFaircoinFxQuote;

/** Decimal parsing and ceil arithmetic are exact. No binary float multiplication
 * or assumed parity between USD and FAIR enters the settlement amount. */
export function faircoinBaseUnitsForUsd(grossMinorUnits: string, usdPerFair: string): string {
  if (!isBaseUnitString(grossMinorUnits) || grossMinorUnits === '0')
    throw new Error('Invalid USD amount');
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/i.exec(usdPerFair);
  if (!match || usdPerFair.length > 80) throw new Error('Invalid FAIR rate');
  const exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30)
    throw new Error('Invalid FAIR rate');
  let numerator = BigInt(`${match[1]}${match[2] ?? ''}`);
  let denominator = 1n;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator = 10n ** BigInt(-exponent);
  if (numerator <= 0n) throw new Error('Invalid FAIR rate');
  const dividend = BigInt(grossMinorUnits) * 1_000_000n * denominator;
  return ((dividend + numerator - 1n) / numerator).toString();
}

/** Same indexed FAIR/USD source as the wallet. Unlike its display cache this
 * commerce reader never falls back to stale data, redirects, or a guessed rate.
 * Deployment must explicitly approve using that indexed price for its quotes. */
export async function createExplorerFaircoinQuote(
  grossMinorUnits: string,
  options: { now?: Date; fetch?: typeof fetch; lifetimeMs?: number } = {},
): Promise<FaircoinFxQuote> {
  const lifetimeMs = options.lifetimeMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 30_000 || lifetimeMs > 15 * 60_000)
    throw new Error('Invalid FAIR quote lifetime');
  const source = `${EXPLORER_BASE_URL}/api/price`;
  const response = await (options.fetch ?? fetch)(source, {
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
    headers: { Accept: 'application/json', 'User-Agent': 'Peable/1.0' },
  });
  if (!response.ok) throw new BillingError('invalid_provider_response', 502);
  const body = (await response.json()) as {
    price?: unknown;
    source?: unknown;
    updatedAt?: unknown;
  } | null;
  const now = options.now ?? new Date();
  // The Explorer indexes WFAIR/USDC on Base as its FAIR/USD reference.
  // This is an explicitly approved commercial reference, not proof of bridge
  // reserves or a guaranteed FAIR redemption rate. No alternate source or
  // manually entered/legacy rate is silently accepted.
  const price = body?.price;
  const observedAt = typeof body?.updatedAt === 'string' ? Date.parse(body.updatedAt) : NaN;
  if (
    body?.source !== 'wfair-base' ||
    (typeof price !== 'number' && typeof price !== 'string') ||
    (typeof price === 'number' && (!Number.isFinite(price) || price <= 0)) ||
    !Number.isFinite(observedAt) ||
    observedAt > +now + 1000 ||
    +now - observedAt > 120_000
  )
    throw new BillingError('invalid_provider_response', 502);
  const rate = String(price);
  const quote = {
    currency: 'USD' as const,
    gross_minor_units: grossMinorUnits,
    amount_base_units: faircoinBaseUnitsForUsd(grossMinorUnits, rate),
    usd_per_fair: rate,
    source,
    observed_at: toUnix(new Date(observedAt)),
    quoted_at: toUnix(now),
    expires_at: toUnix(new Date(+now + lifetimeMs)),
    rounding: 'ceil_to_base_unit' as const,
  };
  return { id: `fx_${createHash('sha256').update(JSON.stringify(quote)).digest('hex')}`, ...quote };
}
