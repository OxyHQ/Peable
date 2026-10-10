/**
 * Tests for FairCoin P2P wire message serialisation.
 *
 * Covers the header framing (magic + command + checksum), version/verack
 * handshake, getheaders, inv, merkleblock, tx, filterload, ping/pong, and
 * addr parsing. Network I/O is not exercised — these tests operate only on
 * byte buffers.
 */

import { describe, test, expect } from 'bun:test';

import { MAINNET, TESTNET, bytesToHex, hexToBytes } from '@fairco.in/core';
import {
  HEADER_SIZE,
  INV_TX,
  INV_BLOCK,
  INV_FILTERED_BLOCK,
  buildMessage,
  ipv4ToMappedIPv6,
  parseAddr,
  parseHeader,
  parseHeaders,
  parseInv,
  parseMerkleBlock,
  parsePong,
  parseTx,
  parseVersion,
  serializeFilterLoad,
  serializeGetData,
  serializeGetHeaders,
  serializeGetBlocks,
  serializeHeader,
  serializePing,
  serializeVersion,
  type VersionPayload,
} from './messages';

const MAINNET_MAGIC = new Uint8Array(MAINNET.magicBytes);
const TESTNET_MAGIC = new Uint8Array(TESTNET.magicBytes);

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

describe('constants', () => {
  test('HEADER_SIZE is 24 bytes', () => {
    expect(HEADER_SIZE).toBe(24);
  });

  test('INV types use the Bitcoin-compatible numeric ids', () => {
    expect(INV_TX).toBe(1);
    expect(INV_BLOCK).toBe(2);
    expect(INV_FILTERED_BLOCK).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// ipv4ToMappedIPv6
// ---------------------------------------------------------------------------

describe('ipv4ToMappedIPv6', () => {
  test('embeds octets in the last 4 bytes of an IPv6 address', () => {
    const bytes = ipv4ToMappedIPv6('1.2.3.4');
    expect(bytes.length).toBe(16);
    expect(bytesToHex(bytes)).toBe('00000000000000000000ffff01020304');
  });

  test('handles the loopback address', () => {
    const bytes = ipv4ToMappedIPv6('127.0.0.1');
    expect(bytes[12]).toBe(127);
    expect(bytes[13]).toBe(0);
    expect(bytes[14]).toBe(0);
    expect(bytes[15]).toBe(1);
    expect(bytes[10]).toBe(0xff);
    expect(bytes[11]).toBe(0xff);
  });

  test('throws on malformed input', () => {
    expect(() => ipv4ToMappedIPv6('1.2.3')).toThrow();
    expect(() => ipv4ToMappedIPv6('1.2.3.256')).toThrow();
    expect(() => ipv4ToMappedIPv6('a.b.c.d')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// serializeHeader / parseHeader
// ---------------------------------------------------------------------------

describe('serializeHeader / parseHeader', () => {
  test('round trip a small payload', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const header = serializeHeader('version', payload, MAINNET_MAGIC);
    expect(header.length).toBe(HEADER_SIZE);
    const parsed = parseHeader(header);
    expect(parsed.command).toBe('version');
    expect(parsed.payloadSize).toBe(payload.length);
    expect(parsed.magic).toEqual(MAINNET_MAGIC);
  });

  test('checksum is the first 4 bytes of double-sha256(payload)', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const header = serializeHeader('version', payload, MAINNET_MAGIC);
    const parsed = parseHeader(header);
    // Reference checksum computed from the probe script above.
    expect(bytesToHex(parsed.checksum)).toBe('19c6197e');
  });

  test('magic bytes occupy the first 4 header bytes', () => {
    const header = serializeHeader('ping', new Uint8Array(0), TESTNET_MAGIC);
    expect(Array.from(header.slice(0, 4))).toEqual([...TESTNET_MAGIC]);
  });

  test('command is null-padded to 12 bytes', () => {
    const header = serializeHeader('ping', new Uint8Array(0), MAINNET_MAGIC);
    // Command bytes are at offsets 4..16
    const cmdBytes = header.slice(4, 16);
    expect(cmdBytes[0]).toBe(0x70); // 'p'
    expect(cmdBytes[1]).toBe(0x69); // 'i'
    expect(cmdBytes[2]).toBe(0x6e); // 'n'
    expect(cmdBytes[3]).toBe(0x67); // 'g'
    for (let i = 4; i < 12; i++) {
      expect(cmdBytes[i]).toBe(0);
    }
  });

  test('long commands are truncated to 12 bytes', () => {
    const header = serializeHeader('somethinglongerthantwelve', new Uint8Array(0), MAINNET_MAGIC);
    const parsed = parseHeader(header);
    expect(parsed.command.length).toBeLessThanOrEqual(12);
    expect(parsed.command).toBe('somethinglon');
  });

  test('throws on a truncated header', () => {
    expect(() => parseHeader(new Uint8Array(10))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildMessage
// ---------------------------------------------------------------------------

describe('buildMessage', () => {
  test('prepends the header to the payload', () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const msg = buildMessage('ping', payload, MAINNET_MAGIC);
    expect(msg.length).toBe(HEADER_SIZE + payload.length);
    // Last bytes must equal the payload
    expect(msg.slice(HEADER_SIZE)).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// version message
// ---------------------------------------------------------------------------

describe('serializeVersion / parseVersion', () => {
  function buildVersion(): VersionPayload {
    return {
      version: 71000,
      services: 1n,
      timestamp: 1_700_000_000n,
      addrRecv: {
        services: 1n,
        ip: ipv4ToMappedIPv6('1.2.3.4'),
        port: 46372,
      },
      addrFrom: {
        services: 0n,
        ip: new Uint8Array(16),
        port: 0,
      },
      nonce: 0xdeadbeefcafebaben,
      userAgent: '/FAIRWallet:1.0.0/',
      startHeight: 1234,
      relay: true,
    };
  }

  test('round trip', () => {
    const v = buildVersion();
    const parsed = parseVersion(serializeVersion(v));
    expect(parsed.version).toBe(v.version);
    expect(parsed.services).toBe(v.services);
    expect(parsed.timestamp).toBe(v.timestamp);
    expect(parsed.nonce).toBe(v.nonce);
    expect(parsed.userAgent).toBe(v.userAgent);
    expect(parsed.startHeight).toBe(v.startHeight);
    expect(parsed.relay).toBe(v.relay);
    expect(parsed.addrRecv.port).toBe(v.addrRecv.port);
    expect(Array.from(parsed.addrRecv.ip)).toEqual(Array.from(v.addrRecv.ip));
  });

  test('port is encoded big-endian', () => {
    const v = buildVersion();
    const bytes = serializeVersion(v);
    // Port of addrRecv sits at offset: 4 (version) + 8 (services) + 8 (ts)
    //   + 8 (services) + 16 (ip) = 44 into the payload
    const portOffset = 4 + 8 + 8 + 8 + 16;
    expect(bytes[portOffset]).toBe((46372 >> 8) & 0xff);
    expect(bytes[portOffset + 1]).toBe(46372 & 0xff);
  });

  test('relay=false round trips', () => {
    const v = buildVersion();
    v.relay = false;
    const parsed = parseVersion(serializeVersion(v));
    expect(parsed.relay).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getheaders
// ---------------------------------------------------------------------------

describe('serializeGetHeaders', () => {
  test('length matches expected: 4 + varint + n*32 + 32', () => {
    const locator = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
    const stop = new Uint8Array(32);
    const bytes = serializeGetHeaders(locator, stop);
    // 4 (version) + 1 (varint for count=2) + 2*32 (locator) + 32 (stop) = 101
    expect(bytes.length).toBe(101);
  });

  test('embeds the FairCoin protocol version 71000 LE', () => {
    const bytes = serializeGetHeaders([], new Uint8Array(32));
    // version is first 4 bytes LE
    expect(bytes[0]).toBe(71000 & 0xff);
    expect(bytes[1]).toBe((71000 >> 8) & 0xff);
    expect(bytes[2]).toBe((71000 >> 16) & 0xff);
    expect(bytes[3]).toBe((71000 >> 24) & 0xff);
  });
});

// ---------------------------------------------------------------------------
// serializeGetBlocks
// ---------------------------------------------------------------------------

describe('serializeGetBlocks', () => {
  test('wire format is identical to getheaders (only the command differs)', () => {
    // FairCoin Core answers `getblocks` (not `getheaders`) with an `inv` of
    // block hashes, which the SPV client requests as filtered blocks. The
    // payload layout is the shared block-locator request.
    const locator = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(9)];
    const stop = new Uint8Array(32);
    expect(serializeGetBlocks(locator, stop)).toEqual(serializeGetHeaders(locator, stop));
  });

  test('length matches 4 + varint + n*32 + 32', () => {
    const bytes = serializeGetBlocks([new Uint8Array(32)], new Uint8Array(32));
    expect(bytes.length).toBe(4 + 1 + 32 + 32);
  });
});

// ---------------------------------------------------------------------------
// parseHeaders
// ---------------------------------------------------------------------------

describe('parseHeaders', () => {
  test('parses an empty headers payload', () => {
    // varint 0x00 = count 0
    const headers = parseHeaders(new Uint8Array([0x00]));
    expect(headers.length).toBe(0);
  });

  test('parses a single synthesized header', () => {
    // Build a single header: 80 bytes + 0x00 tx count
    const buf = new Uint8Array(1 + 80 + 1);
    buf[0] = 0x01; // varint count = 1
    // version = 1 LE
    buf[1] = 0x01;
    // leave prevBlock (32 zero) and merkleRoot (32 zero)
    // timestamp = 42 LE
    const timestampOffset = 1 + 4 + 32 + 32;
    buf[timestampOffset] = 42;
    // bits = 0x11223344 LE
    const bitsOffset = timestampOffset + 4;
    buf[bitsOffset] = 0x44;
    buf[bitsOffset + 1] = 0x33;
    buf[bitsOffset + 2] = 0x22;
    buf[bitsOffset + 3] = 0x11;
    // nonce = 7 LE
    const nonceOffset = bitsOffset + 4;
    buf[nonceOffset] = 7;
    // tx count varint = 0 (already zero)

    const headers = parseHeaders(buf);
    expect(headers.length).toBe(1);
    expect(headers[0].version).toBe(1);
    expect(headers[0].timestamp).toBe(42);
    expect(headers[0].bits).toBe(0x11223344);
    expect(headers[0].nonce).toBe(7);
    expect(headers[0].txCount).toBe(0);
  });

  test('throws on truncated headers payload', () => {
    // varint count = 1 but no header bytes
    expect(() => parseHeaders(new Uint8Array([0x01]))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getdata / inv
// ---------------------------------------------------------------------------

describe('serializeGetData / parseInv', () => {
  test('round trip via serializeGetData and parseInv', () => {
    const items = [
      { type: INV_TX, hash: new Uint8Array(32).fill(0xaa) },
      { type: INV_FILTERED_BLOCK, hash: new Uint8Array(32).fill(0xbb) },
    ];
    // getdata has the same wire format as inv
    const bytes = serializeGetData(items);
    const parsed = parseInv(bytes);
    expect(parsed.length).toBe(2);
    expect(parsed[0].type).toBe(INV_TX);
    expect(parsed[0].hash).toEqual(items[0].hash);
    expect(parsed[1].type).toBe(INV_FILTERED_BLOCK);
    expect(parsed[1].hash).toEqual(items[1].hash);
  });

  test('empty list', () => {
    const bytes = serializeGetData([]);
    const parsed = parseInv(bytes);
    expect(parsed.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// filterload
// ---------------------------------------------------------------------------

describe('serializeFilterLoad', () => {
  test('length matches expected: varint + filter + 4 + 4 + 1', () => {
    const filter = new Uint8Array(16);
    const bytes = serializeFilterLoad(filter, 3, 0x12345678, 1);
    expect(bytes.length).toBe(1 + 16 + 4 + 4 + 1);
    // numHashFuncs = 3 at offset 1 + 16 = 17
    expect(bytes[17]).toBe(3);
    // nTweak is 0x12345678 LE at offset 21
    expect(bytes[21]).toBe(0x78);
    expect(bytes[22]).toBe(0x56);
    expect(bytes[23]).toBe(0x34);
    expect(bytes[24]).toBe(0x12);
    // flags at offset 25
    expect(bytes[25]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// parseMerkleBlock
// ---------------------------------------------------------------------------

describe('parseMerkleBlock', () => {
  test('parses a minimal merkleblock (0 hashes, 1 flag byte)', () => {
    // 80-byte header + totalTransactions(uint32) + varint(hash count=0)
    // + varint(flag len=1) + flag byte
    const size = 80 + 4 + 1 + 1 + 1;
    const buf = new Uint8Array(size);
    // version = 1 LE
    buf[0] = 1;
    // totalTransactions = 1 LE at offset 80
    buf[80] = 1;
    // hash count varint at offset 84 (=0)
    buf[84] = 0;
    // flag len varint = 1 at offset 85
    buf[85] = 1;
    // flag byte at offset 86
    buf[86] = 0x01;

    const mb = parseMerkleBlock(buf);
    expect(mb.version).toBe(1);
    expect(mb.totalTransactions).toBe(1);
    expect(mb.hashes.length).toBe(0);
    expect(mb.flags.length).toBe(1);
    expect(mb.flags[0]).toBe(0x01);
  });
});

// ---------------------------------------------------------------------------
// parseTx
// ---------------------------------------------------------------------------

describe('parseTx', () => {
  test('parses a simple 1-in / 1-out transaction', () => {
    const hex =
      '01000000' + // version
      '01' + // input count
      '0000000000000000000000000000000000000000000000000000000000000000' + // prev txid
      'ffffffff' + // vout
      '00' + // scriptSig len
      'ffffffff' + // sequence
      '01' + // output count
      '00e1f50500000000' + // value
      '1976a914751e76e8199196d454941c45d1b3a323f1433bd688ac' + // scriptPubKey
      '00000000'; // locktime

    const tx = parseTx(hexToBytes(hex));
    expect(tx.version).toBe(1);
    expect(tx.inputs.length).toBe(1);
    expect(tx.outputs.length).toBe(1);
    expect(tx.outputs[0].value).toBe(100_000_000n);
    expect(tx.lockTime).toBe(0);
    // raw is preserved on the parsed struct
    expect(tx.raw.length).toBe(hex.length / 2);
  });
});

// ---------------------------------------------------------------------------
// ping / pong
// ---------------------------------------------------------------------------

describe('serializePing / parsePong', () => {
  test('round trip a 64-bit nonce', () => {
    const nonce = 0xdeadbeefcafebaben;
    const bytes = serializePing(nonce);
    expect(bytes.length).toBe(8);
    expect(parsePong(bytes)).toBe(nonce);
  });

  test('parsePong throws on too-short input', () => {
    expect(() => parsePong(new Uint8Array(4))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseAddr
// ---------------------------------------------------------------------------

describe('parseAddr', () => {
  test('parses an empty addr message', () => {
    // varint count = 0
    const addrs = parseAddr(new Uint8Array([0x00]));
    expect(addrs.length).toBe(0);
  });

  test('parses a single entry', () => {
    // varint count = 1 + 4 (timestamp) + 8 (services) + 16 (ip) + 2 (port)
    const buf = new Uint8Array(1 + 4 + 8 + 16 + 2);
    buf[0] = 1; // count
    // timestamp 12345 LE
    buf[1] = 0x39;
    buf[2] = 0x30;
    // services 0 (already zero)
    // ipv4-mapped 1.2.3.4 at offset 1+4+8 = 13
    buf[13 + 10] = 0xff;
    buf[13 + 11] = 0xff;
    buf[13 + 12] = 1;
    buf[13 + 13] = 2;
    buf[13 + 14] = 3;
    buf[13 + 15] = 4;
    // port 46372 big-endian
    const portOffset = 1 + 4 + 8 + 16;
    buf[portOffset] = (46372 >> 8) & 0xff;
    buf[portOffset + 1] = 46372 & 0xff;

    const addrs = parseAddr(buf);
    expect(addrs.length).toBe(1);
    expect(addrs[0].port).toBe(46372);
    expect(addrs[0].ip[12]).toBe(1);
    expect(addrs[0].ip[15]).toBe(4);
  });
});
