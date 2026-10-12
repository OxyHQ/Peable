/**
 * FairCoin P2P message serialization and deserialization.
 *
 * All messages follow the Bitcoin-derived wire format:
 *   Header (24 bytes) = 4 magic + 12 command + 4 payload-size + 4 checksum
 *   Payload (variable)
 *
 * Multi-byte integers are little-endian unless noted otherwise.
 * Network addresses embed port in **big-endian** (per Bitcoin protocol).
 */

import { sha256 } from '@noble/hashes/sha256';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEADER_SIZE = 24;
const COMMAND_SIZE = 12;
const MAX_MESSAGE_SIZE = 2 * 1024 * 1024; // 2 MB

// Inventory item types
const INV_TX = 1;
const INV_BLOCK = 2;
const INV_FILTERED_BLOCK = 3;

export { HEADER_SIZE, COMMAND_SIZE, MAX_MESSAGE_SIZE, INV_TX, INV_BLOCK, INV_FILTERED_BLOCK };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessageHeader {
  magic: Uint8Array; // 4 bytes
  command: string; // up to 12 chars
  payloadSize: number; // uint32
  checksum: Uint8Array; // 4 bytes
}

export interface NetworkAddress {
  services: bigint; // uint64
  ip: Uint8Array; // 16 bytes (IPv6-mapped IPv4)
  port: number; // uint16 big-endian on wire
}

export interface VersionPayload {
  version: number; // int32 – 71000
  services: bigint; // uint64 – 1 (NODE_NETWORK)
  timestamp: bigint; // int64
  addrRecv: NetworkAddress;
  addrFrom: NetworkAddress;
  nonce: bigint; // uint64
  userAgent: string; // var_str
  startHeight: number; // int32
  relay: boolean;
}

export interface InvItem {
  type: number; // 1=TX, 2=BLOCK, 3=FILTERED_BLOCK
  hash: Uint8Array; // 32 bytes
}

export interface BlockHeaderMsg {
  version: number;
  prevBlock: Uint8Array; // 32 bytes
  merkleRoot: Uint8Array; // 32 bytes
  timestamp: number; // uint32
  bits: number; // uint32
  nonce: number; // uint32
  txCount: number; // varint (always 0 in headers message)
}

export interface MerkleBlockMsg {
  version: number;
  prevBlock: Uint8Array;
  merkleRoot: Uint8Array;
  timestamp: number;
  bits: number;
  nonce: number;
  totalTransactions: number;
  hashes: Uint8Array[];
  flags: Uint8Array;
}

export interface TxInput {
  prevTxHash: Uint8Array; // 32 bytes
  prevTxIndex: number; // uint32
  script: Uint8Array;
  sequence: number; // uint32
}

export interface TxOutput {
  value: bigint; // int64
  script: Uint8Array;
}

export interface ParsedTransaction {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  lockTime: number;
  raw: Uint8Array;
}

export interface PeerAddress {
  timestamp: number; // uint32
  services: bigint;
  ip: Uint8Array;
  port: number;
}

// ---------------------------------------------------------------------------
// Low-level read/write helpers (little-endian unless noted)
// ---------------------------------------------------------------------------

function readUint16BE(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1];
}

function readUint32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] |
      (buf[offset + 1] << 8) |
      (buf[offset + 2] << 16) |
      ((buf[offset + 3] << 24) >>> 0)) >>>
    0
  );
}

function readInt32LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
}

function readUint64LE(buf: Uint8Array, offset: number): bigint {
  const lo = BigInt(readUint32LE(buf, offset));
  const hi = BigInt(readUint32LE(buf, offset + 4));
  return (hi << 32n) | lo;
}

function readInt64LE(buf: Uint8Array, offset: number): bigint {
  const unsigned = readUint64LE(buf, offset);
  // Reinterpret as signed
  if (unsigned >= 1n << 63n) {
    return unsigned - (1n << 64n);
  }
  return unsigned;
}

function writeUint8(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
}

function writeUint16BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

function writeInt32LE(buf: Uint8Array, offset: number, value: number): void {
  writeUint32LE(buf, offset, value);
}

function writeUint64LE(buf: Uint8Array, offset: number, value: bigint): void {
  const lo = Number(value & 0xffffffffn);
  const hi = Number((value >> 32n) & 0xffffffffn);
  writeUint32LE(buf, offset, lo);
  writeUint32LE(buf, offset + 4, hi);
}

function writeInt64LE(buf: Uint8Array, offset: number, value: bigint): void {
  const unsigned = value < 0n ? value + (1n << 64n) : value;
  writeUint64LE(buf, offset, unsigned);
}

// ---------------------------------------------------------------------------
// Variable-length integer (CompactSize)
// ---------------------------------------------------------------------------

interface VarIntResult {
  value: number;
  bytesRead: number;
}

function readVarInt(buf: Uint8Array, offset: number): VarIntResult {
  const first = buf[offset];
  if (first < 0xfd) {
    return { value: first, bytesRead: 1 };
  }
  if (first === 0xfd) {
    const value = buf[offset + 1] | (buf[offset + 2] << 8);
    return { value, bytesRead: 3 };
  }
  if (first === 0xfe) {
    const value = readUint32LE(buf, offset + 1);
    return { value, bytesRead: 5 };
  }
  // first === 0xff  — 8 bytes, but we clamp to safe integer range
  const lo = readUint32LE(buf, offset + 1);
  const hi = readUint32LE(buf, offset + 5);
  const value = hi * 0x100000000 + lo;
  return { value, bytesRead: 9 };
}

function varIntSize(value: number): number {
  if (value < 0xfd) return 1;
  if (value <= 0xffff) return 3;
  if (value <= 0xffffffff) return 5;
  return 9;
}

function writeVarInt(buf: Uint8Array, offset: number, value: number): number {
  if (value < 0xfd) {
    buf[offset] = value;
    return 1;
  }
  if (value <= 0xffff) {
    buf[offset] = 0xfd;
    buf[offset + 1] = value & 0xff;
    buf[offset + 2] = (value >> 8) & 0xff;
    return 3;
  }
  if (value <= 0xffffffff) {
    buf[offset] = 0xfe;
    writeUint32LE(buf, offset + 1, value);
    return 5;
  }
  buf[offset] = 0xff;
  writeUint32LE(buf, offset + 1, value >>> 0);
  writeUint32LE(buf, offset + 5, Math.floor(value / 0x100000000));
  return 9;
}

// ---------------------------------------------------------------------------
// Variable-length string
// ---------------------------------------------------------------------------

function readVarStr(buf: Uint8Array, offset: number): { value: string; bytesRead: number } {
  const lenResult = readVarInt(buf, offset);
  const strBytes = buf.slice(
    offset + lenResult.bytesRead,
    offset + lenResult.bytesRead + lenResult.value,
  );
  const value = new TextDecoder().decode(strBytes);
  return { value, bytesRead: lenResult.bytesRead + lenResult.value };
}

function varStrBytes(str: string): Uint8Array {
  const encoded = new TextEncoder().encode(str);
  const lenSize = varIntSize(encoded.length);
  const result = new Uint8Array(lenSize + encoded.length);
  writeVarInt(result, 0, encoded.length);
  result.set(encoded, lenSize);
  return result;
}

// ---------------------------------------------------------------------------
// Checksum: double-SHA256, first 4 bytes
// ---------------------------------------------------------------------------

function computeChecksum(payload: Uint8Array): Uint8Array {
  return sha256(sha256(payload)).slice(0, 4);
}

// ---------------------------------------------------------------------------
// Network address helpers
// ---------------------------------------------------------------------------

const NET_ADDR_SIZE = 26; // 8 services + 16 ip + 2 port

function writeNetworkAddress(buf: Uint8Array, offset: number, addr: NetworkAddress): void {
  writeUint64LE(buf, offset, addr.services);
  buf.set(addr.ip.slice(0, 16), offset + 8);
  writeUint16BE(buf, offset + 24, addr.port);
}

function readNetworkAddress(buf: Uint8Array, offset: number): NetworkAddress {
  const services = readUint64LE(buf, offset);
  const ip = buf.slice(offset + 8, offset + 24);
  const port = readUint16BE(buf, offset + 24);
  return { services, ip, port };
}

// ---------------------------------------------------------------------------
// Header serialization / parsing
// ---------------------------------------------------------------------------

export function serializeHeader(
  command: string,
  payload: Uint8Array,
  magic: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);

  // Magic bytes
  header.set(magic.slice(0, 4), 0);

  // Command (null-padded to 12 bytes)
  const cmdBytes = new TextEncoder().encode(command);
  const cmdPadded = new Uint8Array(COMMAND_SIZE); // zero-filled
  cmdPadded.set(cmdBytes.slice(0, COMMAND_SIZE), 0);
  header.set(cmdPadded, 4);

  // Payload size
  writeUint32LE(header, 16, payload.length);

  // Checksum
  const checksum = computeChecksum(payload);
  header.set(checksum, 20);

  return header;
}

export function parseHeader(data: Uint8Array): MessageHeader {
  if (data.length < HEADER_SIZE) {
    throw new Error(`Insufficient data for header: need ${HEADER_SIZE}, got ${data.length}`);
  }
  const magic = data.slice(0, 4);

  // Command: read 12 bytes, strip trailing nulls
  const cmdRaw = data.slice(4, 16);
  let cmdEnd = COMMAND_SIZE;
  for (let i = 0; i < COMMAND_SIZE; i++) {
    if (cmdRaw[i] === 0) {
      cmdEnd = i;
      break;
    }
  }
  const command = new TextDecoder().decode(cmdRaw.slice(0, cmdEnd));

  const payloadSize = readUint32LE(data, 16);
  const checksum = data.slice(20, 24);

  return { magic, command, payloadSize, checksum };
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

export function serializeVersion(payload: VersionPayload): Uint8Array {
  const userAgentBytes = varStrBytes(payload.userAgent);
  const size = 4 + 8 + 8 + NET_ADDR_SIZE + NET_ADDR_SIZE + 8 + userAgentBytes.length + 4 + 1;
  const buf = new Uint8Array(size);
  let offset = 0;

  writeInt32LE(buf, offset, payload.version);
  offset += 4;

  writeUint64LE(buf, offset, payload.services);
  offset += 8;

  writeInt64LE(buf, offset, payload.timestamp);
  offset += 8;

  writeNetworkAddress(buf, offset, payload.addrRecv);
  offset += NET_ADDR_SIZE;

  writeNetworkAddress(buf, offset, payload.addrFrom);
  offset += NET_ADDR_SIZE;

  writeUint64LE(buf, offset, payload.nonce);
  offset += 8;

  buf.set(userAgentBytes, offset);
  offset += userAgentBytes.length;

  writeInt32LE(buf, offset, payload.startHeight);
  offset += 4;

  writeUint8(buf, offset, payload.relay ? 1 : 0);

  return buf;
}

export function parseVersion(data: Uint8Array): VersionPayload {
  let offset = 0;

  const version = readInt32LE(data, offset);
  offset += 4;

  const services = readUint64LE(data, offset);
  offset += 8;

  const timestamp = readInt64LE(data, offset);
  offset += 8;

  const addrRecv = readNetworkAddress(data, offset);
  offset += NET_ADDR_SIZE;

  const addrFrom = readNetworkAddress(data, offset);
  offset += NET_ADDR_SIZE;

  const nonce = readUint64LE(data, offset);
  offset += 8;

  const userAgentResult = readVarStr(data, offset);
  offset += userAgentResult.bytesRead;
  const userAgent = userAgentResult.value;

  const startHeight = readInt32LE(data, offset);
  offset += 4;

  // relay byte is optional (BIP37) — default true if not present
  const relay = offset < data.length ? data[offset] !== 0 : true;

  return { version, services, timestamp, addrRecv, addrFrom, nonce, userAgent, startHeight, relay };
}

// ---------------------------------------------------------------------------
// getheaders
// ---------------------------------------------------------------------------

export function serializeGetHeaders(locatorHashes: Uint8Array[], stopHash: Uint8Array): Uint8Array {
  // version (uint32) + varint(count) + count*32 + 32 (stop hash)
  const count = locatorHashes.length;
  const viSize = varIntSize(count);
  const size = 4 + viSize + count * 32 + 32;
  const buf = new Uint8Array(size);
  let offset = 0;

  // Protocol version in getheaders is the protocol version, but the field
  // is actually the "version" of the getheaders message (uint32).
  // Bitcoin protocol uses 70015, FairCoin uses 71000.
  writeUint32LE(buf, offset, 71000);
  offset += 4;

  offset += writeVarInt(buf, offset, count);

  for (const hash of locatorHashes) {
    buf.set(hash.slice(0, 32), offset);
    offset += 32;
  }

  buf.set(stopHash.slice(0, 32), offset);

  return buf;
}

// ---------------------------------------------------------------------------
// getblocks
// ---------------------------------------------------------------------------

/**
 * Serialize a `getblocks` request. Wire format is identical to `getheaders`
 * (version + block locator + hash_stop); only the command differs. FairCoin
 * Core (3.0.5) does NOT answer `getheaders` with a `headers` message — it uses
 * the legacy block-announcement path, replying to `getblocks` with an `inv` of
 * block hashes, which the SPV client then requests as filtered (merkle) blocks.
 */
export function serializeGetBlocks(locatorHashes: Uint8Array[], stopHash: Uint8Array): Uint8Array {
  return serializeGetHeaders(locatorHashes, stopHash);
}

// ---------------------------------------------------------------------------
// headers (response)
// ---------------------------------------------------------------------------

export function parseHeaders(data: Uint8Array): BlockHeaderMsg[] {
  let offset = 0;
  const countResult = readVarInt(data, offset);
  offset += countResult.bytesRead;
  const count = countResult.value;

  const headers: BlockHeaderMsg[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 80 > data.length) {
      throw new Error(`Truncated headers message at header ${i}`);
    }

    const version = readInt32LE(data, offset);
    offset += 4;

    const prevBlock = data.slice(offset, offset + 32);
    offset += 32;

    const merkleRoot = data.slice(offset, offset + 32);
    offset += 32;

    const timestamp = readUint32LE(data, offset);
    offset += 4;

    const bits = readUint32LE(data, offset);
    offset += 4;

    const nonce = readUint32LE(data, offset);
    offset += 4;

    // Transaction count (varint, always 0 in headers message)
    const txCountResult = readVarInt(data, offset);
    offset += txCountResult.bytesRead;

    headers.push({
      version,
      prevBlock,
      merkleRoot,
      timestamp,
      bits,
      nonce,
      txCount: txCountResult.value,
    });
  }

  return headers;
}

// ---------------------------------------------------------------------------
// getdata / inv
// ---------------------------------------------------------------------------

export function serializeGetData(items: InvItem[]): Uint8Array {
  const viSize = varIntSize(items.length);
  const buf = new Uint8Array(viSize + items.length * 36);
  let offset = 0;

  offset += writeVarInt(buf, offset, items.length);
  for (const item of items) {
    writeUint32LE(buf, offset, item.type);
    offset += 4;
    buf.set(item.hash.slice(0, 32), offset);
    offset += 32;
  }

  return buf;
}

export function parseInv(data: Uint8Array): InvItem[] {
  let offset = 0;
  const countResult = readVarInt(data, offset);
  offset += countResult.bytesRead;
  const count = countResult.value;

  const items: InvItem[] = [];
  for (let i = 0; i < count; i++) {
    const type = readUint32LE(data, offset);
    offset += 4;
    const hash = data.slice(offset, offset + 32);
    offset += 32;
    items.push({ type, hash });
  }

  return items;
}

// ---------------------------------------------------------------------------
// filterload (BIP37)
// ---------------------------------------------------------------------------

export function serializeFilterLoad(
  filter: Uint8Array,
  nHashFuncs: number,
  nTweak: number,
  nFlags: number,
): Uint8Array {
  const viSize = varIntSize(filter.length);
  const buf = new Uint8Array(viSize + filter.length + 4 + 4 + 1);
  let offset = 0;

  offset += writeVarInt(buf, offset, filter.length);
  buf.set(filter, offset);
  offset += filter.length;

  writeUint32LE(buf, offset, nHashFuncs);
  offset += 4;

  writeUint32LE(buf, offset, nTweak);
  offset += 4;

  writeUint8(buf, offset, nFlags);

  return buf;
}

// ---------------------------------------------------------------------------
// merkleblock
// ---------------------------------------------------------------------------

export function parseMerkleBlock(data: Uint8Array): MerkleBlockMsg {
  let offset = 0;

  const version = readInt32LE(data, offset);
  offset += 4;

  const prevBlock = data.slice(offset, offset + 32);
  offset += 32;

  const merkleRoot = data.slice(offset, offset + 32);
  offset += 32;

  const timestamp = readUint32LE(data, offset);
  offset += 4;

  const bits = readUint32LE(data, offset);
  offset += 4;

  const nonce = readUint32LE(data, offset);
  offset += 4;

  const totalTransactions = readUint32LE(data, offset);
  offset += 4;

  // Hashes
  const hashCountResult = readVarInt(data, offset);
  offset += hashCountResult.bytesRead;
  const hashes: Uint8Array[] = [];
  for (let i = 0; i < hashCountResult.value; i++) {
    hashes.push(data.slice(offset, offset + 32));
    offset += 32;
  }

  // Flags
  const flagLenResult = readVarInt(data, offset);
  offset += flagLenResult.bytesRead;
  const flags = data.slice(offset, offset + flagLenResult.value);

  return {
    version,
    prevBlock,
    merkleRoot,
    timestamp,
    bits,
    nonce,
    totalTransactions,
    hashes,
    flags,
  };
}

// ---------------------------------------------------------------------------
// tx
// ---------------------------------------------------------------------------

export function parseTx(data: Uint8Array): ParsedTransaction {
  const raw = data.slice();
  let offset = 0;

  const version = readInt32LE(data, offset);
  offset += 4;

  // Input count
  const inCountResult = readVarInt(data, offset);
  offset += inCountResult.bytesRead;

  const inputs: TxInput[] = [];
  for (let i = 0; i < inCountResult.value; i++) {
    const prevTxHash = data.slice(offset, offset + 32);
    offset += 32;

    const prevTxIndex = readUint32LE(data, offset);
    offset += 4;

    const scriptLenResult = readVarInt(data, offset);
    offset += scriptLenResult.bytesRead;

    const script = data.slice(offset, offset + scriptLenResult.value);
    offset += scriptLenResult.value;

    const sequence = readUint32LE(data, offset);
    offset += 4;

    inputs.push({ prevTxHash, prevTxIndex, script, sequence });
  }

  // Output count
  const outCountResult = readVarInt(data, offset);
  offset += outCountResult.bytesRead;

  const outputs: TxOutput[] = [];
  for (let i = 0; i < outCountResult.value; i++) {
    const value = readInt64LE(data, offset);
    offset += 8;

    const scriptLenResult = readVarInt(data, offset);
    offset += scriptLenResult.bytesRead;

    const script = data.slice(offset, offset + scriptLenResult.value);
    offset += scriptLenResult.value;

    outputs.push({ value, script });
  }

  const lockTime = readUint32LE(data, offset);

  return { version, inputs, outputs, lockTime, raw };
}

// ---------------------------------------------------------------------------
// ping / pong
// ---------------------------------------------------------------------------

export function serializePing(nonce: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  writeUint64LE(buf, 0, nonce);
  return buf;
}

export function parsePong(data: Uint8Array): bigint {
  if (data.length < 8) {
    throw new Error(`Pong payload too short: ${data.length}`);
  }
  return readUint64LE(data, 0);
}

// ---------------------------------------------------------------------------
// addr
// ---------------------------------------------------------------------------

export function parseAddr(data: Uint8Array): PeerAddress[] {
  let offset = 0;
  const countResult = readVarInt(data, offset);
  offset += countResult.bytesRead;
  const count = countResult.value;

  const addresses: PeerAddress[] = [];
  for (let i = 0; i < count; i++) {
    // Each entry: 4 (timestamp) + 8 (services) + 16 (ip) + 2 (port) = 30 bytes
    const timestamp = readUint32LE(data, offset);
    offset += 4;

    const netAddr = readNetworkAddress(data, offset);
    offset += NET_ADDR_SIZE;

    addresses.push({
      timestamp,
      services: netAddr.services,
      ip: netAddr.ip,
      port: netAddr.port,
    });
  }

  return addresses;
}

// ---------------------------------------------------------------------------
// Utility: build a full wire message (header + payload)
// ---------------------------------------------------------------------------

export function buildMessage(command: string, payload: Uint8Array, magic: Uint8Array): Uint8Array {
  const header = serializeHeader(command, payload, magic);
  const message = new Uint8Array(header.length + payload.length);
  message.set(header, 0);
  message.set(payload, header.length);
  return message;
}

// ---------------------------------------------------------------------------
// Utility: IPv4-mapped IPv6 address (::ffff:x.x.x.x)
// ---------------------------------------------------------------------------

export function ipv4ToMappedIPv6(ipv4Str: string): Uint8Array {
  const parts = ipv4Str.split('.');
  if (parts.length !== 4) {
    throw new Error(`Invalid IPv4 address: ${ipv4Str}`);
  }
  const result = new Uint8Array(16);
  // Bytes 0-9: 0x00
  // Bytes 10-11: 0xff
  result[10] = 0xff;
  result[11] = 0xff;
  // Bytes 12-15: IPv4 octets
  for (let i = 0; i < 4; i++) {
    const octet = parseInt(parts[i], 10);
    if (octet < 0 || octet > 255 || Number.isNaN(octet)) {
      throw new Error(`Invalid IPv4 octet: ${parts[i]}`);
    }
    result[12 + i] = octet;
  }
  return result;
}
