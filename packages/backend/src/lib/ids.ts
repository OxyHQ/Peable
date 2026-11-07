const ID_ENTROPY_BYTES = 12;
const SECRET_ENTROPY_BYTES = 16;

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Mint a public id.
 *
 * The prefix union is CLOSED on purpose: a public id is the thing a merchant
 * quotes back in a support conversation, and a typo'd prefix produces an id
 * that looks valid, is unique, and belongs to no object type anyone can look
 * up. A new object type adds itself here deliberately.
 */
export function newId(
  prefix:
    | 'pi'
    | 'ch'
    | 'cus'
    | 'pm'
    | 'seti'
    // Identity verification (ADR 0023): sessions and their reports.
    | 'vs'
    | 'vr'
    // Terminal (ADR 0024): locations and readers.
    | 'tml'
    | 'tmr'
    | 'prod'
    | 'price'
    | 'coupon'
    | 'promo'
    | 'sub'
    | 'si'
    | 'in'
    | 'il'
    | 'ii'
    | 'cn'
    | 'qt'
    | 'cnli'
    | 'cbtxn'
    | 'clock'
    | 'mtr'
    | 'feat'
    | 'prodft'
    | 'bpc'
    | 'bps'
    | 'evt'
    | 'merch'
    | 'link'
    | 'cs'
    | 'li'
    | 'ca'
    | 'tr'
    | 'trr'
    | 're'
    | 'dp'
    | 'taxreg'
    | 'taxloc'
    | 'taxcalc'
    | 'taxtxn'
    // Peable Tax business compliance (ADR 0020): operating locations, sales
    // destinations, registration declarations, documents, assessments, review
    // items and the action history.
    | 'taxol'
    | 'taxdest'
    | 'taxrd'
    | 'taxdoc'
    | 'taxasm'
    | 'taxrev'
    | 'taxact'
    | 'we'
    | 'req'
    | 'file'
    | 'pmc'
    | 'pmd'
    // Orbit money (ADR 0015): balance transactions, payouts, application fees and
    // their refunds, and reconciliation findings.
    | 'txn'
    | 'po'
    | 'fee'
    | 'fr'
    | 'recon'
    // Reporting: a report run (Stripe's `frr_`) and a report schedule.
    | 'frr'
    | 'frs'
    // Risk rules (ADR 0022): a rule, an evaluation that matched, a review (Stripe's `prv_`).
    | 'rule'
    | 'reval'
    | 'prv',
): string {
  return `${prefix}_${randomHex(ID_ENTROPY_BYTES)}`;
}

export function clientSecretFor(id: string): string {
  return `${id}_secret_${randomHex(SECRET_ENTROPY_BYTES)}`;
}

/**
 * A bearer token for an anonymous payer page (a hosted invoice, a portal
 * session): 32 random bytes, hex. Unguessable like a payment link id, and long
 * enough that it is never the thing an attacker enumerates.
 */
export function newBearerToken(prefix: 'inv' | 'bps'): string {
  return `${prefix}_tok_${randomHex(32)}`;
}
