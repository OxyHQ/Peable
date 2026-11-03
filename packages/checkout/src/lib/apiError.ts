// The gateway's refusals (ADR 0014 envelopes, mapped by the SDK into
// `PeableError`s) as this app shows them: a message, and the field it is about.

export interface FieldError {
  /** The field, dotted (`customer_details.email`, `line_items.0.quantity`), or `null`. */
  readonly param: string | null;
  readonly message: string;
}

/**
 * `customer_details[address][line1]` and `customer_details.address.line1` are
 * one field. The gateway names params in bracket notation; this app keys its
 * fields dotted.
 */
export function normalizeParam(param: string): string {
  return param.replace(/\[([^\]]*)\]/g, '.$1').replace(/^\./, '');
}

export function fieldErrorOf(error: unknown, fallback: string): FieldError {
  if (error instanceof Error) {
    const param = (error as { param?: unknown }).param;
    return {
      param: typeof param === 'string' && param.length > 0 ? normalizeParam(param) : null,
      message: error.message || fallback,
    };
  }
  return { param: null, message: fallback };
}
