import { z } from 'zod';

/**
 * `metadata` — the merchant's own key/value bag (ADR 0014 D1), with Stripe's
 * limits: at most 50 keys, a key at most 40 characters, a value at most 500.
 *
 * The limits exist because the bag is stored on the row and returned on every
 * read, list and webhook of the object: an unbounded bag is an unbounded
 * response a merchant's own integration pays for on every page.
 *
 * Two schemas, because create and update mean different things by the same
 * body:
 *
 * - on CREATE the bag is the whole bag; an empty-string value is simply absent
 *   (there is nothing to unset yet);
 * - on UPDATE the bag is a PATCH: named keys are set, a key sent as `""` is
 *   removed, and keys not named are kept (`db/metadata.ts` merges it in one
 *   statement). The 50-key limit is then judged on the merged result, which
 *   only the database can see.
 */
export const METADATA_MAX_KEYS = 50;
export const METADATA_KEY_MAX = 40;
export const METADATA_VALUE_MAX = 500;

export interface MetadataPatch {
  readonly set: Record<string, string>;
  readonly unset: readonly string[];
}

const metadataKey = z
  .string()
  .min(1, 'metadata keys cannot be empty')
  .max(METADATA_KEY_MAX, `metadata keys are at most ${METADATA_KEY_MAX} characters`)
  // A key is quoted back in bracket notation (`metadata[order_id]`) in every
  // error's `param`; a key containing brackets would make that ambiguous.
  .refine((key) => !/[[\]]/.test(key), 'metadata keys cannot contain square brackets');

const metadataValue = z
  .string()
  .max(METADATA_VALUE_MAX, `metadata values are at most ${METADATA_VALUE_MAX} characters`);

const metadataBag = z
  .record(metadataKey, metadataValue)
  .refine(
    (bag) => Object.keys(bag).length <= METADATA_MAX_KEYS,
    `metadata holds at most ${METADATA_MAX_KEYS} keys`,
  );

/** The bag a create stores. Empty values are dropped: there is nothing to unset yet. */
export const metadataCreateSchema = metadataBag.transform(
  (bag): Record<string, string> =>
    Object.fromEntries(Object.entries(bag).filter(([, value]) => value !== '')),
);

/** The patch an update applies. */
export const metadataUpdateSchema = metadataBag.transform(
  (bag): MetadataPatch => ({
    set: Object.fromEntries(Object.entries(bag).filter(([, value]) => value !== '')),
    unset: Object.entries(bag)
      .filter(([, value]) => value === '')
      .map(([key]) => key),
  }),
);

/** The answer when the MERGED bag would exceed the key limit. */
export const METADATA_LIMIT_MESSAGE = `metadata holds at most ${METADATA_MAX_KEYS} keys`;
