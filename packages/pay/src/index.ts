/**
 * `@peable.to/pay` — the self-custodial FairCoin payment client an Oxy app
 * embeds.
 *
 * It exists because paying someone should not require the Peable app. Every
 * Oxy app on a device shares one identity key, and the wallet is derived from
 * it, so any of them can hold the same wallet. What they could not do is the
 * rest: select coins, build a transaction, sign it. That code lived inside the
 * Peable app, next to an SQLite database and an SPV node.
 *
 * This package is the part that needs neither. It is the SAME code the Peable
 * wallet runs — moved here, not copied, because two implementations of coin
 * selection is two answers to "how much money is this".
 *
 * WHAT IT IS NOT: key custody. Nothing here reads or stores an identity key;
 * a caller passes in the seed it already derived on-device.
 */

export { KeyManager } from './wallet/key-manager';
export type { DerivedAddress } from './wallet/key-manager';
export { UTXOSet } from './wallet/utxo-set';
export type { UTXO } from './wallet/utxo-set';
export {
  selectInputsForSend,
  estimateFeeForInputs,
  estimateSend,
} from './wallet/coin-selection';
export type {
  SelectInputsParams,
  SelectedInputs,
  SendEstimate,
} from './wallet/coin-selection';

export { fetchAddressInfo } from './explorer/address';
export type { AddressInfo } from './explorer/address';
export { discoverUtxos } from './explorer/discovery';
export type { AddressSource } from './explorer/discovery';
export { broadcastTransaction, fetchFeePerByte } from './explorer/broadcast';
