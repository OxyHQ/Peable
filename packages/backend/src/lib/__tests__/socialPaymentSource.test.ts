import { describe, expect, it } from 'bun:test';
import { toSocialPaymentSource } from '../serialize';

/**
 * The row → wire half of "what was this payment for".
 *
 * Pure and therefore tested without a database: the storage half (that the two
 * columns round-trip, and that a ref without an app is refused) lives in
 * `db/__tests__/webhookAndAttributionRepository.realdb.test.ts`, where a real
 * server can answer it.
 */
describe('toSocialPaymentSource', () => {
  it('omits the context entirely for a plain person-to-person payment', () => {
    // `undefined`, not `{ app: 'unknown' }`: a payment with no context is the
    // ordinary case, and a placeholder would be the gateway asserting something
    // no payer said. `JSON.stringify` then drops the key, so the wire shows no
    // `source` at all rather than a null one.
    expect(toSocialPaymentSource({ sourceApp: null, sourceRef: null })).toBeUndefined();
  });

  it('carries the app and the ref back exactly as they were stored', () => {
    // Verbatim is the contract. A `ref` is opaque — Peable never parses,
    // resolves or links it — so anything this function did to the string other
    // than copy it would be the gateway starting to interpret what its users
    // pay for.
    expect(toSocialPaymentSource({ sourceApp: 'mention', sourceRef: 'post_abc123' })).toEqual({
      app: 'mention',
      ref: 'post_abc123',
    });
  });

  it('keeps the context of an app that named no single thing', () => {
    // `app` decides, never `ref`. Keying off `ref` would silently drop the
    // context whenever an app says which app it is without pointing at one
    // post — and `ref` is absent, not `null`, because the contract types it
    // optional and `JSON.stringify` drops the two differently.
    const source = toSocialPaymentSource({ sourceApp: 'mention', sourceRef: null });
    expect(source).toEqual({ app: 'mention' });
    expect(Object.keys(source ?? {})).toEqual(['app']);
  });
});
