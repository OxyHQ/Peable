/**
 * BIP37 Bloom filter for SPV transaction matching.
 *
 * The filter is sent to connected peers via `filterload` so they only relay
 * transactions (and merkle blocks) that match addresses the wallet controls.
 *
 * Hash function: MurmurHash3 (32-bit) with a seed derived from
 *   (nHashNum * 0xFBA4C795 + nTweak) for each hash function index.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BLOOM_UPDATE_NONE = 0;
export const BLOOM_UPDATE_ALL = 1;
export const BLOOM_UPDATE_P2PUBKEY_ONLY = 2;

const LN2_SQUARED = 0.4804530139182014246671025263266649717305529515945455;
const LN2 = 0.6931471805599453094172321214581765680755001343602552;
const MAX_BLOOM_FILTER_SIZE = 36000; // bytes
const MAX_HASH_FUNCS = 50;
const MURMURHASH_SEED_MULTIPLIER = 0xfba4c795;

// ---------------------------------------------------------------------------
// MurmurHash3 (32-bit, x86 variant)
// ---------------------------------------------------------------------------

/**
 * MurmurHash3 32-bit hash as used by BIP37 bloom filters.
 * Operates on a Uint8Array with the given 32-bit seed.
 */
function murmurHash3(data: Uint8Array, seed: number): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  const length = data.length;
  const roundedEnd = length & ~3; // = length - (length % 4)

  let h1 = seed >>> 0;

  // Body: process 4-byte chunks
  for (let i = 0; i < roundedEnd; i += 4) {
    let k1 =
      (data[i] & 0xff) |
      ((data[i + 1] & 0xff) << 8) |
      ((data[i + 2] & 0xff) << 16) |
      ((data[i + 3] & 0xff) << 24);

    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);

    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = Math.imul(h1, 5) + 0xe6546b64;
  }

  // Tail: remaining bytes
  let k1 = 0;
  const tailIndex = roundedEnd;
  // Falls through intentionally for each remaining byte
  if ((length & 3) >= 3) {
    k1 ^= (data[tailIndex + 2] & 0xff) << 16;
  }
  if ((length & 3) >= 2) {
    k1 ^= (data[tailIndex + 1] & 0xff) << 8;
  }
  if ((length & 3) >= 1) {
    k1 ^= data[tailIndex] & 0xff;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }

  // Finalization
  h1 ^= length;

  // fmix32
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;

  return h1 >>> 0;
}

// ---------------------------------------------------------------------------
// BloomFilter
// ---------------------------------------------------------------------------

export class BloomFilter {
  private readonly data: Uint8Array;
  readonly numHashFuncs: number;
  readonly tweak: number;
  private readonly flags: number;

  constructor(size: number, numHashFuncs: number, tweak: number, flags: number) {
    const clampedSize = Math.min(size, MAX_BLOOM_FILTER_SIZE);
    this.data = new Uint8Array(clampedSize);
    this.numHashFuncs = Math.min(numHashFuncs, MAX_HASH_FUNCS);
    this.tweak = tweak;
    this.flags = flags;
  }

  /**
   * Compute the hash for a given function index.
   * Seed = (hashIndex * 0xFBA4C795 + tweak) mod 2^32
   */
  private hash(hashIndex: number, data: Uint8Array): number {
    const seed =
      ((Math.imul(hashIndex, MURMURHASH_SEED_MULTIPLIER) + this.tweak) & 0xffffffff) >>> 0;
    return murmurHash3(data, seed) % (this.data.length * 8);
  }

  /**
   * Insert an element into the filter.
   */
  insert(element: Uint8Array): void {
    for (let i = 0; i < this.numHashFuncs; i++) {
      const bitIndex = this.hash(i, element);
      this.data[bitIndex >>> 3] |= 1 << (bitIndex & 7);
    }
  }

  /**
   * Test whether an element is (probably) in the filter.
   *
   * A filter with zero hash functions (e.g. the empty filter built by
   * `forAddresses([])`) matches nothing: returning `true` here would make an
   * uninitialised filter vacuously match every element, defeating the privacy
   * and bandwidth purpose of the Bloom filter (the SPV peer would relay every
   * transaction on the network). Guard that case explicitly.
   */
  contains(element: Uint8Array): boolean {
    if (this.numHashFuncs === 0 || this.data.length === 0) {
      return false;
    }
    for (let i = 0; i < this.numHashFuncs; i++) {
      const bitIndex = this.hash(i, element);
      if ((this.data[bitIndex >>> 3] & (1 << (bitIndex & 7))) === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Return the raw filter bytes (for use in `filterload`).
   */
  toBytes(): Uint8Array {
    return this.data.slice();
  }

  /**
   * Return the number of hash functions.
   */
  getNumHashFuncs(): number {
    return this.numHashFuncs;
  }

  /**
   * Return the tweak value.
   */
  getTweak(): number {
    return this.tweak;
  }

  /**
   * Return the flags byte.
   */
  getFlags(): number {
    return this.flags;
  }

  /**
   * Create a bloom filter optimally sized for a set of addresses/items.
   *
   * @param addresses - Array of data elements (e.g. pubkey hashes) to include
   * @param falsePositiveRate - Target false-positive rate (e.g. 0.0001 for 0.01%)
   */
  static forAddresses(addresses: Uint8Array[], falsePositiveRate: number): BloomFilter {
    const n = addresses.length;
    if (n === 0) {
      // Return minimal filter
      return new BloomFilter(1, 0, 0, BLOOM_UPDATE_ALL);
    }

    // Optimal filter size in bytes:
    //   size = -1.0 / LN2_SQUARED * n * log(fp) / 8
    const filterBits = Math.ceil((-1.0 / LN2_SQUARED) * n * Math.log(falsePositiveRate));
    const filterSize = Math.min(Math.max(Math.ceil(filterBits / 8), 1), MAX_BLOOM_FILTER_SIZE);

    // Optimal number of hash functions:
    //   k = filterSizeBytes * 8 / n * LN2
    const numHashFuncs = Math.min(
      Math.max(Math.round(((filterSize * 8) / n) * LN2), 1),
      MAX_HASH_FUNCS,
    );

    // Use a random tweak for privacy
    const tweakBytes = new Uint8Array(4);
    crypto.getRandomValues(tweakBytes);
    const tweak =
      (tweakBytes[0] |
        (tweakBytes[1] << 8) |
        (tweakBytes[2] << 16) |
        ((tweakBytes[3] << 24) >>> 0)) >>>
      0;

    const filter = new BloomFilter(filterSize, numHashFuncs, tweak, BLOOM_UPDATE_ALL);

    for (const addr of addresses) {
      filter.insert(addr);
    }

    return filter;
  }
}
