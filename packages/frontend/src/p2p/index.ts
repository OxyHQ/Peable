/**
 * FairCoin P2P network layer.
 *
 * Re-exports all public types and classes for the SPV client.
 */

export {
  type MessageHeader,
  type NetworkAddress,
  type VersionPayload,
  type InvItem,
  type BlockHeaderMsg,
  type MerkleBlockMsg,
  type TxInput,
  type TxOutput,
  type ParsedTransaction,
  type PeerAddress,
  HEADER_SIZE,
  COMMAND_SIZE,
  MAX_MESSAGE_SIZE,
  INV_TX,
  INV_BLOCK,
  INV_FILTERED_BLOCK,
  serializeHeader,
  parseHeader,
  serializeVersion,
  parseVersion,
  serializeGetHeaders,
  parseHeaders,
  serializeGetData,
  parseInv,
  serializeFilterLoad,
  parseMerkleBlock,
  parseTx,
  serializePing,
  parsePong,
  parseAddr,
  buildMessage,
  ipv4ToMappedIPv6,
} from './messages';

export {
  BloomFilter,
  BLOOM_UPDATE_NONE,
  BLOOM_UPDATE_ALL,
  BLOOM_UPDATE_P2PUBKEY_ONLY,
} from './bloom-filter';

export {
  type SocketConnection,
  type SocketProvider,
  type PeerState,
  type PeerConfig,
  type PeerEvents,
  Peer,
} from './peer';

export {
  type PeerManagerConfig,
  type MessageHandler,
  PeerManager,
} from './peer-manager';

export {
  type StoredBlockHeader,
  type HeaderStore,
  type SPVClientConfig,
  type SPVClientEvents,
  SPVClient,
} from './spv-client';

export {
  type NativeDnsResolver,
  resolveDNSSeeds,
  getFallbackPeers,
} from './dns-seeds';

export {
  type MasternodeVin,
  type MasternodeAddr,
  type MasternodePing,
  type MasternodeBroadcast,
  type CreateMasternodeBroadcastParams,
  serializeMasternodeBroadcast,
  serializeMasternodePing,
  createMasternodeBroadcast,
  signMasternodePing,
  hashMasternodeBroadcast,
} from './masternode';

export { createSocketProvider } from './socket-provider';

export { DatabaseHeaderStore } from './header-store';
