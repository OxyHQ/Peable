import type { RadarEvaluation, RadarRule, Review } from '@peable.to/shared-types';
import type { RadarEvaluationRow, RadarRuleRow, ReviewRow } from '../db/radar/radarRepository';
import { toUnix, toUnixOrNull } from './time';

/** Risk rules, evaluations and reviews on the wire (ADR 0022). */

export function toRadarRuleDTO(row: RadarRuleRow): RadarRule {
  return {
    id: row.publicId,
    object: 'radar.rule',
    livemode: row.livemode,
    action: row.action,
    predicate: row.predicate,
    description: row.description,
    enabled: row.enabled,
    version: row.version,
    created: toUnix(row.createdAt),
    updated: toUnix(row.updatedAt),
  };
}

export function toRadarEvaluationDTO(row: RadarEvaluationRow): RadarEvaluation {
  return {
    id: row.publicId,
    object: 'radar.evaluation',
    livemode: row.livemode,
    payment_intent: row.paymentIntentPublicId,
    phase: row.phase,
    decision: row.decision,
    rule: {
      id: row.ruleId,
      action: row.decision,
      predicate: row.rulePredicate,
      version: row.ruleVersion,
    },
    facts: row.facts,
    created: toUnix(row.createdAt),
  };
}

export function toReviewDTO(row: ReviewRow): Review {
  return {
    id: row.publicId,
    object: 'review',
    livemode: row.livemode,
    open: row.closedReason === null,
    reason: row.closedReason ?? row.openedReason,
    opened_reason: row.openedReason,
    closed_reason: row.closedReason,
    payment_intent: row.paymentIntentPublicId,
    charge: row.chargePublicId,
    rule:
      row.ruleId !== null &&
      row.ruleVersion !== null &&
      row.ruleAction !== null &&
      row.rulePredicate !== null
        ? {
            id: row.ruleId,
            action: row.ruleAction,
            predicate: row.rulePredicate,
            version: row.ruleVersion,
          }
        : null,
    created: toUnix(row.createdAt),
    closed_at: toUnixOrNull(row.closedAt),
  };
}
