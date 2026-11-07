/**
 * Writing a merchant's risk rules (ADR 0022 D1). Every predicate is compiled
 * before it is stored, so a stored rule always parses against the registry it
 * was written for; a refusal is a 400 naming `predicate` and the position.
 */
import { RADAR_LIMITS, type RadarRuleAction } from '@peable.to/shared-types';
import { listChargesForMerchant } from '../../db/payments/chargeRepository';
import { findIntentsByIds } from '../../db/payments/paymentIntentRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { getDb } from '../../db/postgres';
import {
  deleteRadarRule,
  findRadarRuleForMerchant,
  insertRadarRule,
  type RadarRuleRow,
  updateRadarRule,
} from '../../db/radar/radarRepository';
import { RadarError } from './errors';
import { decide, gatherFacts } from './evaluate';
import { compileRule, RadarRuleError, type CompiledRule } from './language';

/** Compile, or refuse with the parser's reason and position. */
export function compileOrRefuse(predicate: string): CompiledRule {
  try {
    return compileRule(predicate);
  } catch (error) {
    if (error instanceof RadarRuleError) {
      throw new RadarError('parameter_invalid', `predicate: ${error.message}`, 'predicate');
    }
    throw error;
  }
}

export async function createRule(
  merchant: MerchantRow,
  input: {
    readonly action: RadarRuleAction;
    readonly predicate: string;
    readonly description?: string | undefined;
    readonly enabled?: boolean | undefined;
  },
): Promise<RadarRuleRow> {
  compileOrRefuse(input.predicate);
  const row = await insertRadarRule(getDb(), {
    merchantId: merchant.id,
    action: input.action,
    predicate: input.predicate,
    description: input.description ?? null,
    enabled: input.enabled ?? true,
  });
  if (row === 'limit_reached') {
    throw new RadarError(
      'rule_limit_reached',
      'this merchant has the most risk rules allowed; delete one first',
      undefined,
      409,
    );
  }
  return row;
}

async function ruleOf(merchant: MerchantRow, publicId: string): Promise<RadarRuleRow> {
  const row = await findRadarRuleForMerchant(getDb(), publicId, merchant.id);
  if (!row) throw new RadarError('resource_missing', 'risk rule not found', undefined, 404);
  return row;
}

export async function updateRule(
  merchant: MerchantRow,
  publicId: string,
  patch: {
    readonly action?: RadarRuleAction | undefined;
    readonly predicate?: string | undefined;
    readonly description?: string | undefined;
    readonly enabled?: boolean | undefined;
  },
): Promise<RadarRuleRow> {
  const rule = await ruleOf(merchant, publicId);
  if (patch.predicate !== undefined) compileOrRefuse(patch.predicate);
  const updated = await updateRadarRule(getDb(), rule.id, {
    action: patch.action,
    predicate: patch.predicate,
    description: patch.description === undefined ? undefined : patch.description || null,
    enabled: patch.enabled,
  });
  if (!updated) throw new RadarError('resource_missing', 'risk rule not found', undefined, 404);
  return updated;
}

export async function deleteRule(merchant: MerchantRow, publicId: string): Promise<RadarRuleRow> {
  const rule = await ruleOf(merchant, publicId);
  if (!(await deleteRadarRule(getDb(), rule.id))) {
    throw new RadarError('resource_missing', 'risk rule not found', undefined, 404);
  }
  return rule;
}

/** One payment a previewed predicate would have matched. */
export interface PreviewMatch {
  readonly paymentIntent: string;
  readonly amount: string;
  readonly currency: string;
  readonly created: Date;
  readonly facts: Record<string, string | null>;
}

/**
 * "Test this rule against recent payments": judge a predicate, unsaved,
 * against the merchant's newest card charges with their post-authorization
 * facts. Read-only and bounded — `RADAR_LIMITS.previewPaymentsMax` charges,
 * a quarter of them when the predicate names a velocity fact (one statement
 * each).
 */
export async function previewPredicate(
  merchant: MerchantRow,
  predicate: string,
): Promise<{ evaluated: number; matched: PreviewMatch[] }> {
  const compiled = compileOrRefuse(predicate);
  const velocity = [...compiled.facts].some((fact) => fact.includes('_per_'));
  const limit = velocity
    ? Math.ceil(RADAR_LIMITS.previewPaymentsMax / 4)
    : RADAR_LIMITS.previewPaymentsMax;
  const db = getDb();
  const { data: charges } = await listChargesForMerchant(db, {
    merchantId: merchant.id,
    page: { limit },
  });
  const intents = new Map(
    (
      await findIntentsByIds(
        db,
        charges.map((charge) => charge.paymentIntentId),
      )
    ).map((intent) => [intent.id, intent]),
  );
  const matched: PreviewMatch[] = [];
  for (const charge of charges) {
    const intent = intents.get(charge.paymentIntentId);
    if (!intent) continue;
    const facts = await gatherFacts(db, intent, 'post_authorization', { charge }, compiled.facts);
    const decision = decide(
      [
        {
          row: {
            id: 'preview',
            publicId: 'preview',
            merchantId: merchant.id,
            livemode: merchant.livemode,
            action: 'review',
            predicate,
            description: null,
            enabled: true,
            version: 1,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
          compiled,
        },
      ],
      facts,
    );
    if (decision) {
      matched.push({
        paymentIntent: intent.publicId,
        amount: intent.amount,
        currency: intent.currency,
        created: intent.createdAt,
        facts: decision.facts,
      });
    }
  }
  return { evaluated: charges.length, matched };
}
