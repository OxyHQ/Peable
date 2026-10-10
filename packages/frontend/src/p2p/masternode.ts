/**
 * Masternode P2P protocol messages.
 * Implements masternode broadcast and ping for FairCoin's PIVX-derived protocol.
 *
 * Message types:
 * - `mnb` (masternode broadcast): Announces a masternode to the network
 * - `mnp` (masternode ping): Periodic keepalive from a masternode
 *
 * Serialization follows Bitcoin/PIVX wire format (little-endian integers,
 * CompactSize varints, big-endian port in network addresses).
 */

import { sha256 } from '@noble/hashes/sha256';
import * as secp256k1 from '@noble/secp256k1';

import { BufferWriter, bytesToHex } from '@fairco.in/core';
import { ipv4ToMappedIPv6 } from './messages';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MasternodeVin {
  /** 32-byte collateral transaction hash. */
  txid: Uint8Array;
  /** Collateral output index (uint32). */
  vout: number;
  /** Script signature (typically empty for unsigned outpoint references). */
  scriptSig: Uint8Array;
  /** Sequence number (uint32), typically 0xffffffff. */
  sequence: number;
}

export interface MasternodeAddr {
  /** 16 bytes (IPv6-mapped IPv4). */
  ip: Uint8Array;
  /** Port number (uint16, big-endian on wire). */
  port: number;
}

export interface MasternodePing {
  /** Collateral outpoint identifying the masternode. */
  vin: MasternodeVin;
  /** 32-byte best known block hash. */
  blockHash: Uint8Array;
  /** Signature timestamp (int64). */
  sigTime: bigint;
  /** ECDSA signature proving the masternode is alive. */
  sig: Uint8Array;
}

export interface MasternodeBroadcast {
  /** Collateral outpoint (5,000 FAIR UTXO). */
  vin: MasternodeVin;
  /** Masternode service address (IP:port). */
  addr: MasternodeAddr;
  /** Public key of collateral address. */
  pubKeyCollateral: Uint8Array;
  /** Public key of masternode (operator key). */
  pubKeyMasternode: Uint8Array;
  /** Signature proving collateral ownership. */
  sig: Uint8Array;
  /** Signature timestamp (int64). */
  sigTime: bigint;
  /** Protocol version (71000). */
  protocolVersion: number;
  /** Last ping message. */
  lastPing: MasternodePing;
  /** Last darksend queue participation (int64). */
  nLastDsq: bigint;
}

// ---------------------------------------------------------------------------
// Parameters for creating a broadcast
// ---------------------------------------------------------------------------

export interface CreateMasternodeBroadcastParams {
  /** 32-byte collateral transaction hash. */
  collateralTxid: Uint8Array;
  /** Collateral output index. */
  collateralVout: number;
  /** Masternode IP address (IPv4 string, e.g. "1.2.3.4"). */
  masternodeIp: string;
  /** Masternode port. */
  masternodePort: number;
  /** Compressed public key of collateral address. */
  pubKeyCollateral: Uint8Array;
  /** Compressed public key of masternode operator. */
  pubKeyMasternode: Uint8Array;
  /** Private key for signing (collateral address, 32 bytes). */
  collateralPrivKey: Uint8Array;
  /** Private key for the masternode operator (32 bytes). */
  masternodePrivKey: Uint8Array;
  /** Best known block hash (32 bytes). */
  blockHash: Uint8Array;
  /** Protocol version (default 71000). */
  protocolVersion?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PROTOCOL_VERSION = 71000;
const DEFAULT_SEQUENCE = 0xffffffff;

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeVin(writer: BufferWriter, vin: MasternodeVin): void {
  if (vin.txid.length !== 32) {
    throw new Error(`MasternodeVin txid must be 32 bytes, got ${vin.txid.length}`);
  }
  writer.writeBytes(vin.txid);
  writer.writeUInt32LE(vin.vout);
  writer.writeVarInt(vin.scriptSig.length);
  writer.writeBytes(vin.scriptSig);
  writer.writeUInt32LE(vin.sequence);
}

function serializeAddr(writer: BufferWriter, addr: MasternodeAddr): void {
  if (addr.ip.length !== 16) {
    throw new Error(`MasternodeAddr ip must be 16 bytes, got ${addr.ip.length}`);
  }
  writer.writeBytes(addr.ip);
  // Port is big-endian on the wire
  const portBuf = new Uint8Array(2);
  portBuf[0] = (addr.port >> 8) & 0xff;
  portBuf[1] = addr.port & 0xff;
  writer.writeBytes(portBuf);
}

function writeInt64LE(writer: BufferWriter, value: bigint): void {
  const unsigned = value < 0n ? value + (1n << 64n) : value;
  writer.writeUInt64LE(unsigned);
}

function serializeVarBytes(writer: BufferWriter, data: Uint8Array): void {
  writer.writeVarInt(data.length);
  writer.writeBytes(data);
}

// ---------------------------------------------------------------------------
// Double SHA-256 for message signing
// ---------------------------------------------------------------------------

function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/**
 * Build the message to sign for a masternode ping.
 * Format: vin serialization + blockHash + sigTime (as string, per PIVX protocol)
 */
function buildPingSignatureMessage(
  vin: MasternodeVin,
  blockHash: Uint8Array,
  sigTime: bigint,
): Uint8Array {
  const writer = new BufferWriter();
  serializeVin(writer, vin);
  writer.writeBytes(blockHash);
  // PIVX protocol encodes sigTime as its decimal string representation for hashing
  const sigTimeStr = new TextEncoder().encode(sigTime.toString());
  writer.writeBytes(sigTimeStr);
  return doubleSha256(writer.toBytes());
}

/**
 * Build the message to sign for a masternode broadcast.
 * Format: addr + sigTime (string) + pubKeyCollateral + pubKeyMasternode + protocolVersion (string)
 */
function buildBroadcastSignatureMessage(
  addr: MasternodeAddr,
  sigTime: bigint,
  pubKeyCollateral: Uint8Array,
  pubKeyMasternode: Uint8Array,
  protocolVersion: number,
): Uint8Array {
  const writer = new BufferWriter();
  serializeAddr(writer, addr);
  const sigTimeStr = new TextEncoder().encode(sigTime.toString());
  writer.writeBytes(sigTimeStr);
  serializeVarBytes(writer, pubKeyCollateral);
  serializeVarBytes(writer, pubKeyMasternode);
  const protoStr = new TextEncoder().encode(protocolVersion.toString());
  writer.writeBytes(protoStr);
  return doubleSha256(writer.toBytes());
}

/**
 * Encode a bigint as a DER integer (minimal, positive).
 */
function derEncodeInteger(n: bigint): Uint8Array {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) {
    hex = '0' + hex;
  }
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  // If high bit is set, prepend 0x00 to keep it positive
  if (bytes.length > 0 && bytes[0] >= 0x80) {
    bytes.unshift(0x00);
  }
  return new Uint8Array([0x02, bytes.length, ...bytes]);
}

/**
 * DER-encode an ECDSA signature from r and s bigints.
 * Format: 0x30 <total len> 0x02 <r len> <r> 0x02 <s len> <s>
 */
function derEncodeSignature(r: bigint, s: bigint): Uint8Array {
  const rEnc = derEncodeInteger(r);
  const sEnc = derEncodeInteger(s);
  const totalLen = rEnc.length + sEnc.length;
  const result = new Uint8Array(2 + totalLen);
  result[0] = 0x30;
  result[1] = totalLen;
  result.set(rEnc, 2);
  result.set(sEnc, 2 + rEnc.length);
  return result;
}

/**
 * Sign a message hash with a private key and return a DER-encoded signature.
 */
function signMessageHash(messageHash: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const signature = secp256k1.sign(messageHash, privateKey);
  const normalizedSig = signature.hasHighS() ? signature.normalizeS() : signature;
  return derEncodeSignature(normalizedSig.r, normalizedSig.s);
}

// ---------------------------------------------------------------------------
// Public API: Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a MasternodePing to wire format.
 */
export function serializeMasternodePing(ping: MasternodePing): Uint8Array {
  const writer = new BufferWriter();
  serializeVin(writer, ping.vin);
  if (ping.blockHash.length !== 32) {
    throw new Error(`MasternodePing blockHash must be 32 bytes, got ${ping.blockHash.length}`);
  }
  writer.writeBytes(ping.blockHash);
  writeInt64LE(writer, ping.sigTime);
  serializeVarBytes(writer, ping.sig);
  return writer.toBytes();
}

/**
 * Serialize a MasternodeBroadcast to wire format.
 */
export function serializeMasternodeBroadcast(mnb: MasternodeBroadcast): Uint8Array {
  const writer = new BufferWriter();

  // Collateral vin
  serializeVin(writer, mnb.vin);

  // Service address
  serializeAddr(writer, mnb.addr);

  // Public keys (varint-prefixed)
  serializeVarBytes(writer, mnb.pubKeyCollateral);
  serializeVarBytes(writer, mnb.pubKeyMasternode);

  // Signature (varint-prefixed)
  serializeVarBytes(writer, mnb.sig);

  // Signature time
  writeInt64LE(writer, mnb.sigTime);

  // Protocol version
  writer.writeInt32LE(mnb.protocolVersion);

  // Last ping
  writer.writeBytes(serializeMasternodePing(mnb.lastPing));

  // nLastDsq
  writeInt64LE(writer, mnb.nLastDsq);

  return writer.toBytes();
}

// ---------------------------------------------------------------------------
// Public API: Creating and signing
// ---------------------------------------------------------------------------

/**
 * Create and sign a masternode ping message.
 *
 * @param vin - Collateral outpoint identifying the masternode
 * @param blockHash - 32-byte best known block hash
 * @param privKey - 32-byte masternode operator private key
 * @returns Signed MasternodePing
 */
export function signMasternodePing(
  vin: MasternodeVin,
  blockHash: Uint8Array,
  privKey: Uint8Array,
): MasternodePing {
  if (blockHash.length !== 32) {
    throw new Error(`blockHash must be 32 bytes, got ${blockHash.length}`);
  }
  if (privKey.length !== 32) {
    throw new Error(`privKey must be 32 bytes, got ${privKey.length}`);
  }

  const sigTime = BigInt(Math.floor(Date.now() / 1000));
  const messageHash = buildPingSignatureMessage(vin, blockHash, sigTime);
  const sig = signMessageHash(messageHash, privKey);

  return {
    vin,
    blockHash,
    sigTime,
    sig,
  };
}

/**
 * Create and sign a masternode broadcast message.
 *
 * This constructs the full MasternodeBroadcast including a signed ping,
 * ready to be serialized and sent to the P2P network.
 */
export function createMasternodeBroadcast(
  params: CreateMasternodeBroadcastParams,
): MasternodeBroadcast {
  const {
    collateralTxid,
    collateralVout,
    masternodeIp,
    masternodePort,
    pubKeyCollateral,
    pubKeyMasternode,
    collateralPrivKey,
    masternodePrivKey,
    blockHash,
    protocolVersion = DEFAULT_PROTOCOL_VERSION,
  } = params;

  if (collateralTxid.length !== 32) {
    throw new Error(`collateralTxid must be 32 bytes, got ${collateralTxid.length}`);
  }
  if (blockHash.length !== 32) {
    throw new Error(`blockHash must be 32 bytes, got ${blockHash.length}`);
  }
  if (collateralPrivKey.length !== 32) {
    throw new Error(`collateralPrivKey must be 32 bytes, got ${collateralPrivKey.length}`);
  }
  if (masternodePrivKey.length !== 32) {
    throw new Error(`masternodePrivKey must be 32 bytes, got ${masternodePrivKey.length}`);
  }

  const vin: MasternodeVin = {
    txid: collateralTxid,
    vout: collateralVout,
    scriptSig: new Uint8Array(0),
    sequence: DEFAULT_SEQUENCE,
  };

  const addr: MasternodeAddr = {
    ip: ipv4ToMappedIPv6(masternodeIp),
    port: masternodePort,
  };

  const sigTime = BigInt(Math.floor(Date.now() / 1000));

  // Sign the broadcast message with the collateral private key
  const broadcastMsgHash = buildBroadcastSignatureMessage(
    addr,
    sigTime,
    pubKeyCollateral,
    pubKeyMasternode,
    protocolVersion,
  );
  const sig = signMessageHash(broadcastMsgHash, collateralPrivKey);

  // Create a signed ping for the last ping field
  const lastPing = signMasternodePing(vin, blockHash, masternodePrivKey);

  return {
    vin,
    addr,
    pubKeyCollateral,
    pubKeyMasternode,
    sig,
    sigTime,
    protocolVersion,
    lastPing,
    nLastDsq: 0n,
  };
}

/**
 * Compute the hash of a masternode broadcast for inventory purposes.
 * This is the double-SHA256 of the serialized broadcast.
 */
export function hashMasternodeBroadcast(mnb: MasternodeBroadcast): string {
  const raw = serializeMasternodeBroadcast(mnb);
  const hash = doubleSha256(raw);
  // Display in reversed byte order (same convention as txids)
  const reversed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    reversed[i] = hash[31 - i];
  }
  return bytesToHex(reversed);
}
