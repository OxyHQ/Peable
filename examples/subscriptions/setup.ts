// One-time catalog setup: a "Pro" product, its monthly price, and the feature
// it grants. Safe to run again: everything is found by its lookup key first.
import { FEATURE_LOOKUP_KEY, PRICE_LOOKUP_KEY, peable } from './peable';

let [price] = (await peable.prices.list({ lookup_keys: [PRICE_LOOKUP_KEY], active: true })).data;
if (!price) {
  const product = await peable.products.create({ name: 'Pro' });
  // Amounts are base-unit strings: '900' is 9.00 EUR. Prices are immutable —
  // to change one, create another with `transfer_lookup_key: true`.
  price = await peable.prices.create({
    product: product.id,
    currency: 'EUR',
    unit_amount: '900',
    recurring: { interval: 'month' },
    lookup_key: PRICE_LOOKUP_KEY,
  });
}
const productId = typeof price.product === 'string' ? price.product : price.product.id;

const [existing] = (await peable.entitlements.features.list({ lookup_key: FEATURE_LOOKUP_KEY }))
  .data;
const feature =
  existing ??
  (await peable.entitlements.features.create({
    lookup_key: FEATURE_LOOKUP_KEY,
    name: 'Pro features',
  }));

// Access is the customer's active entitlements, whichever product grants them.
const granted = await peable.entitlements.productFeatures.list(productId).autoPagingToArray({
  limit: 100,
});
if (!granted.some((link) => link.entitlement_feature.id === feature.id)) {
  await peable.entitlements.productFeatures.attach(productId, { entitlement_feature: feature.id });
}

console.log(`price ${price.id} (${PRICE_LOOKUP_KEY}) grants ${feature.lookup_key}`);
