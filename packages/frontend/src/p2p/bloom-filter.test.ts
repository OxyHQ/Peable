/**
 * Tests for the BIP37 Bloom filter and its MurmurHash3 hash function.
 *
 * Inserted elements must always match (no false negatives).
 * Non-inserted elements should usually not match; because of the
 * probabilistic nature of Bloom filters we check the *aggregate*
 * behaviour across a large pool of synthetic elements and compare
 * against a reasonable upper bound rather than asserting zero.
 */

import { describe, test, expect } from 'bun:test';

import {
  BLOOM_UPDATE_ALL,
  BLOOM_UPDATE_NONE,
  BLOOM_UPDATE_P2PUBKEY_ONLY,
  BloomFilter,
} from './bloom-filter';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('flag constants', () => {
  test('update modes are 0 / 1 / 2', () => {
    expect(BLOOM_UPDATE_NONE).toBe(0);
    expect(BLOOM_UPDATE_ALL).toBe(1);
    expect(BLOOM_UPDATE_P2PUBKEY_ONLY).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Manual filter
// ---------------------------------------------------------------------------

describe('BloomFilter (manual size)', () => {
  test('contains an inserted element', () => {
    const filter = new BloomFilter(64, 10, 0, BLOOM_UPDATE_ALL);
    const element = new Uint8Array([1, 2, 3, 4]);
    filter.insert(element);
    expect(filter.contains(element)).toBe(true);
  });

  test('contains does not false-negative on any inserted element', () => {
    const filter = new BloomFilter(512, 10, 0xdeadbeef, BLOOM_UPDATE_ALL);
    const elements: Uint8Array[] = [];
    for (let i = 0; i < 100; i++) {
      const el = new Uint8Array(20);
      const view = new DataView(el.buffer);
      view.setUint32(0, i, true);
      elements.push(el);
      filter.insert(el);
    }
    for (const el of elements) {
      expect(filter.contains(el)).toBe(true);
    }
  });

  test('toBytes returns a copy, not the underlying buffer', () => {
    const filter = new BloomFilter(16, 3, 0, BLOOM_UPDATE_ALL);
    filter.insert(new Uint8Array([1, 2, 3]));
    const a = filter.toBytes();
    const b = filter.toBytes();
    expect(a).not.toBe(b); // different references
    expect(a).toEqual(b); // same contents
    // Mutating the returned bytes must not affect the filter
    a.fill(0);
    expect(filter.toBytes()[0]).not.toBe(a[0]);
  });

  test('accessors return the constructor arguments', () => {
    const filter = new BloomFilter(32, 7, 12345, BLOOM_UPDATE_P2PUBKEY_ONLY);
    expect(filter.getNumHashFuncs()).toBe(7);
    expect(filter.getTweak()).toBe(12345);
    expect(filter.getFlags()).toBe(BLOOM_UPDATE_P2PUBKEY_ONLY);
  });

  test('filter size is clamped to 36000 bytes', () => {
    const filter = new BloomFilter(1_000_000, 1, 0, BLOOM_UPDATE_ALL);
    expect(filter.toBytes().length).toBeLessThanOrEqual(36000);
  });

  test('numHashFuncs is clamped to 50', () => {
    const filter = new BloomFilter(32, 500, 0, BLOOM_UPDATE_ALL);
    expect(filter.getNumHashFuncs()).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// BloomFilter.forAddresses
// ---------------------------------------------------------------------------

describe('BloomFilter.forAddresses', () => {
  test('empty address list returns a minimal placeholder filter that matches nothing', () => {
    const filter = BloomFilter.forAddresses([], 0.0001);
    expect(filter.toBytes().length).toBeGreaterThanOrEqual(1);
    expect(filter.getNumHashFuncs()).toBe(0);

    // SPV_AUDIT.md §4.8: a 0-hash-func filter must NOT match every element.
    // Previously `contains` iterated over zero hash functions and returned
    // `true` vacuously, so an empty filter matched everything (a privacy and
    // bandwidth bug — the peer would relay the whole network's traffic).
    for (let i = 0; i < 256; i++) {
      const el = new Uint8Array([i, (i * 31) & 0xff, 0xab, 0xcd]);
      expect(filter.contains(el)).toBe(false);
    }
  });

  test('a manually constructed 0-hash-func filter matches nothing', () => {
    const filter = new BloomFilter(8, 0, 0, BLOOM_UPDATE_ALL);
    expect(filter.contains(new Uint8Array([1, 2, 3, 4]))).toBe(false);
    expect(filter.contains(new Uint8Array(0))).toBe(false);
  });

  test('all inserted elements match', () => {
    const addresses: Uint8Array[] = [];
    for (let i = 0; i < 50; i++) {
      const el = new Uint8Array(20);
      el[0] = i;
      el[1] = (i * 7) & 0xff;
      addresses.push(el);
    }
    const filter = BloomFilter.forAddresses(addresses, 0.0001);
    for (const el of addresses) {
      expect(filter.contains(el)).toBe(true);
    }
  });

  test('false positive rate stays close to the target', () => {
    // Insert a small set of "owned" addresses
    const addresses: Uint8Array[] = [];
    for (let i = 0; i < 20; i++) {
      const el = new Uint8Array(20);
      el.fill(i & 0xff);
      addresses.push(el);
    }
    const fpRate = 0.01;
    const filter = BloomFilter.forAddresses(addresses, fpRate);

    // Probe with a large pool of definitely-not-inserted elements and
    // count matches. The 5x multiplier gives the (small) sample test
    // room to stay within bounds.
    let fp = 0;
    const probes = 10_000;
    for (let i = 0; i < probes; i++) {
      const el = new Uint8Array(20);
      // Offset into a region we never inserted
      el[0] = 0xaa;
      const view = new DataView(el.buffer);
      view.setUint32(16, i + 1, true);
      if (filter.contains(el)) {
        fp++;
      }
    }

    const actualFpRate = fp / probes;
    // Allow for statistical noise — cap at 5x the target
    expect(actualFpRate).toBeLessThan(fpRate * 5);
  });
});

// ---------------------------------------------------------------------------
// Determinism / cross-run stability
// ---------------------------------------------------------------------------

describe('BloomFilter determinism', () => {
  test('inserting in different orders gives the same filter bytes', () => {
    const a = new BloomFilter(64, 5, 0, BLOOM_UPDATE_ALL);
    const b = new BloomFilter(64, 5, 0, BLOOM_UPDATE_ALL);
    const elements = [
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
      new Uint8Array([4]),
    ];
    for (const el of elements) a.insert(el);
    // Insert into b in reverse order
    for (let i = elements.length - 1; i >= 0; i--) b.insert(elements[i]);
    expect(a.toBytes()).toEqual(b.toBytes());
  });

  test('different tweak produces different bit positions', () => {
    // Two filters with the same size and same element but different
    // tweaks must produce different filter bytes with high probability.
    // We test a handful of different tweaks to reduce flake risk.
    const el = new Uint8Array([1, 2, 3, 4, 5]);
    const baseline = new BloomFilter(64, 5, 0, BLOOM_UPDATE_ALL);
    baseline.insert(el);
    const baselineBytes = baseline.toBytes();

    let differentCount = 0;
    for (const tweak of [1, 2, 3, 4, 5]) {
      const filter = new BloomFilter(64, 5, tweak, BLOOM_UPDATE_ALL);
      filter.insert(el);
      const bytes = filter.toBytes();
      if (bytesToHex(bytes) !== bytesToHex(baselineBytes)) {
        differentCount++;
      }
    }
    expect(differentCount).toBeGreaterThan(0);
  });
});

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}
