import { describe, expect, test } from 'bun:test';
import { contractRegistry, objectSchema, objectTypes } from '../common/objects';
import { taxCodeSchema, taxRoutes } from '../resources/tax';
import { isKnownTaxCode, TAX_CODES } from '../vocabulary/tax';

describe('Peable Tax contracts', () => {
  test('every example of a tax object is what its schema accepts', () => {
    const failures: string[] = [];
    for (const type of objectTypes().filter((each) => each.startsWith('tax.'))) {
      const schema = objectSchema(type);
      if (!schema) continue;
      for (const example of contractRegistry.get(schema)?.examples ?? []) {
        const parsed = schema.safeParse(example);
        if (!parsed.success) failures.push(`${type}: ${parsed.error.message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('the tax-code catalog is what its schema describes', () => {
    for (const code of TAX_CODES) {
      expect(taxCodeSchema.safeParse(code).success).toBe(true);
      expect(isKnownTaxCode(code.id)).toBe(true);
    }
    expect(isKnownTaxCode('txcd_99999999')).toBe(false);
  });

  test('every tax route is under /v1/tax and names its SDK method under tax.', () => {
    for (const route of taxRoutes) {
      expect(route.path.startsWith('/v1/tax/')).toBe(true);
      expect(route.sdk.startsWith('tax.')).toBe(true);
    }
  });
});
