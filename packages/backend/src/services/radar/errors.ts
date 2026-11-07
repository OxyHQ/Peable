import type { ErrorCode } from '@peable.to/contracts/vocabulary';

/**
 * A refusal from risk rules or reviews (ADR 0022), answered as the ADR 0014
 * envelope by the route runner (`sendCatalogError`).
 */
export class RadarError extends Error {
  constructor(
    readonly code: Extract<
      ErrorCode,
      | 'parameter_invalid'
      | 'resource_missing'
      | 'resource_conflict'
      | 'rule_limit_reached'
      | 'review_not_open'
      | 'payment_intent_unexpected_state'
      | 'rail_unavailable'
    > | null,
    message: string,
    readonly param?: string,
    readonly status: 400 | 404 | 409 | 502 | 503 = 400,
  ) {
    super(message);
    this.name = 'RadarError';
  }
}
