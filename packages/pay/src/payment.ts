/**
 * Paying someone, from a seed and a destination and nothing else.
 *
 * The pieces below this — HD derivation, gap-limit discovery, coin selection,
 * the builder and signer in `@fairco.in/core`, the Explorer — were each already
 * here and each individually testable. What was missing is the ONE order they
 * have to run in, because getting it wrong is not a crash: it is a transaction
 * the network keeps, paying the wrong fee, spending the wrong coins, or sending
 * change somewhere the wallet cannot reach.
 *
 * So this file is deliberately thin. It adds no money logic of its own — every
 * amount here comes from `selectInputsForSend` or from the built transaction —
 * and what it does add is sequencing and refusals.
 *
 * NO KEY CUSTODY: the seed arrives as an argument, is used to derive, and the
 * derived material is wiped before the call returns. Nothing here reads or
 * writes a keystore, and there is no way to ask this module for a key.
 */

import {
  buildTransaction,
  bytesToHex,
  getNetwork,
  serializeTransaction,
  signInput,
  type NetworkType,
  type Transaction,
} from '@fairco.in/core';
import { KeyManager } from './wallet/key-manager';
import { UTXOSet, type UTXO } from './wallet/utxo-set';
import { estimateSend, selectInputsForSend, type SelectedInputs } from './wallet/coin-selection';
import { discoverUtxos } from './explorer/discovery';
import { fetchAddressInfo, type AddressInfo } from './explorer/address';
import { broadcastTransaction, fetchFeePerByte } from './explorer/broadcast';
import { fetchChainTip } from './explorer/chain-tip';

/**
 * The four things a payment asks of the outside world, injectable as a group.
 *
 * Tests replace them so the whole flow — real derivation, real selection, real
 * signing, real serialization — runs without a network and without a mainnet
 * payment. Everything not passed falls back to the real Explorer call, so a
 * caller that wants the shipped behaviour passes nothing.
 */
export interface ChainAccess {
  readonly fetchAddressInfo?: (
    addresses: readonly string[],
    network: NetworkType
  ) => Promise<Map<string, AddressInfo>>;
  readonly fetchFeePerByte?: (network: NetworkType) => Promise<number>;
  readonly fetchChainTip?: (network: NetworkType) => Promise<number>;
  readonly broadcastTransaction?: (
    rawTransactionHex: string,
    network: NetworkType
  ) => Promise<string>;
}

/** What a wallet is, to this module: a seed and the chain it spends on. */
export interface WalletRef {
  /**
   * BIP39 seed bytes. The caller derives these on-device — from
   * `KeyManager.deriveSeed(mnemonic)` or an Oxy identity key — and owns them.
   * They are read, never stored, and never zeroed here: wiping an argument
   * would destroy a buffer the caller may still need.
   */
  readonly seed: Uint8Array;
  readonly network: NetworkType;
  /**
   * Confirmations an output needs before this wallet will spend it. Defaults to
   * 1 and cannot be 0: see {@link resolveMinConfirmations}.
   */
  readonly minConfirmations?: number;
}

/**
 * What a payment costs is decided entirely by the wallet's own coins, the
 * amount and the rate — the destination changes nothing. So a quote does not
 * ask for one: a send screen shows the fee and the maximum sendable while the
 * address field is still empty, and requiring `to` there would force a caller
 * to invent a placeholder address and quote against a payment nobody is making.
 */
export interface QuoteRequest extends WalletRef {
  readonly amountSat: bigint;
  /**
   * Fee rate in base units per byte. Omitted, the Explorer is asked. There is
   * no default constant — see {@link resolveFeePerByte}.
   */
  readonly feePerByte?: number;
}

export interface PaymentRequest extends QuoteRequest {
  /** Destination address. Validated by the builder against `network`. */
  readonly to: string;
}

export interface PaymentResult {
  /** The txid the DAEMON returned: what was accepted, not what was sent. */
  readonly txid: string;
  /** What the transaction actually pays, derived from inputs minus outputs. */
  readonly feeSat: bigint;
}

export interface PaymentQuote {
  /** Fee for the inputs selection would pick, or null when unaffordable. */
  readonly feeSat: bigint | null;
  /** amount + fee, or null when unaffordable. */
  readonly totalSat: bigint | null;
  readonly insufficientFunds: boolean;
  /** Most that could be sent right now: spendable total minus its own fee. */
  readonly maxSendableSat: bigint;
  /**
   * The rate this quote was priced at. Pass it back to {@link sendPayment} to
   * be charged what the quote said: quoting and sending at two separately
   * fetched rates is two different fees for one decision.
   */
  readonly feePerByte: number;
}

export interface WalletBalance {
  /** Confirmed to the requested depth — the only money that can be spent. */
  readonly spendableSat: bigint;
  /** Discovered but not yet spendable (in the mempool, or not deep enough). */
  readonly pendingSat: bigint;
  readonly totalSat: bigint;
}

/**
 * Pay `amountSat` to `to`, and return the txid the network accepted.
 *
 * Discovers the wallet's coins, selects inputs, builds, signs and broadcasts.
 * Every failure happens as early as it can: an amount the wallet cannot cover
 * throws during selection, before a single input is signed and long before
 * anything is handed to the network.
 */
export async function sendPayment(
  request: PaymentRequest,
  chain: ChainAccess = {}
): Promise<PaymentResult> {
  const { seed, network, to, amountSat } = request;
  const networkConfig = getNetwork(network);
  const feePerByte = await resolveFeePerByte(request.feePerByte, network, chain);

  const keyManager = KeyManager.fromSeed(seed, networkConfig);
  try {
    const spendable = await loadSpendable(keyManager, request, chain);

    // Selection is the single decision about which coins move and what the fee
    // is. It throws on insufficient funds, which is why it runs before the
    // builder, the signer and the broadcaster exist in this function at all.
    const selection = selectInputsForSend({
      candidates: spendable,
      targetValue: amountSat,
      feePerByte,
      dustThreshold: networkConfig.minRelayFee,
    });

    // Change must land somewhere this wallet can spend from again. The address
    // comes from our own key manager so it always can — the assertion is here
    // because the day it does not, the money is gone with no error anywhere:
    // the transaction is valid, confirms, and pays a stranger.
    const changeAddress = keyManager.getNextChangeAddress().address;
    if (!keyManager.ownsAddress(changeAddress)) {
      throw new Error('Refusing to send: change address is not owned by this wallet');
    }

    const transaction = buildTransaction({
      utxos: selection.selected.map((utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        scriptPubKey: utxo.scriptPubKey,
      })),
      recipients: [{ address: to, value: amountSat }],
      changeAddress,
      feePerByte: BigInt(feePerByte),
      network: networkConfig,
    });

    const feeSat = feePaidBy(transaction, selection);

    signEveryInput(transaction, selection.selected, keyManager);

    const broadcast = chain.broadcastTransaction ?? broadcastTransaction;
    const txid = await broadcast(bytesToHex(serializeTransaction(transaction)), network);
    return { txid, feeSat };
  } finally {
    // The derived spending keys live only for this call. A caller embedding
    // this in a long-running app would otherwise keep every private key for
    // every address of this wallet in the heap for the life of the process,
    // for one payment.
    keyManager.wipe();
  }
}

/**
 * What a payment WOULD cost, without making one.
 *
 * Nothing is signed and nothing is sent. An amount the wallet cannot cover is
 * `insufficientFunds: true` rather than a throw, because a UI asks this on every
 * keystroke and an exception per keypress is not an answer.
 */
export async function quotePayment(
  request: QuoteRequest,
  chain: ChainAccess = {}
): Promise<PaymentQuote> {
  const { seed, network, amountSat } = request;
  const networkConfig = getNetwork(network);
  const feePerByte = await resolveFeePerByte(request.feePerByte, network, chain);

  const keyManager = KeyManager.fromSeed(seed, networkConfig);
  try {
    const spendable = await loadSpendable(keyManager, request, chain);

    // Same function, same parameters, same dust rule as the send path. Two
    // implementations of "what does this cost" is a quote that is not the bill.
    const estimate = estimateSend({
      candidates: spendable,
      targetValue: amountSat,
      feePerByte,
      dustThreshold: networkConfig.minRelayFee,
    });

    return {
      feeSat: estimate.fee,
      totalSat: estimate.total,
      insufficientFunds: estimate.insufficientFunds,
      maxSendableSat: estimate.maxSendable,
      feePerByte,
    };
  } finally {
    keyManager.wipe();
  }
}

/**
 * What the wallet holds, split by what it can actually spend.
 *
 * `spendableSat` and `pendingSat` are reported separately rather than summed,
 * because a wallet that shows one number is a wallet whose owner is told a
 * payment will go through and then watches it fail on funds that are on screen.
 */
export async function readBalance(
  wallet: WalletRef,
  chain: ChainAccess = {}
): Promise<WalletBalance> {
  const keyManager = KeyManager.fromSeed(wallet.seed, getNetwork(wallet.network));
  try {
    const discovered = await discover(keyManager, wallet.network, chain);
    const spendable = await filterSpendable(discovered, wallet, chain);

    // Summed through a UTXOSet rather than over the array: discovery can return
    // the same outpoint twice when a scan window overlaps, and adding a value
    // to a balance twice is the one arithmetic error a wallet must never make.
    // The set is keyed by outpoint, so a repeat replaces rather than adds.
    const all = new UTXOSet();
    for (const utxo of discovered) all.add(utxo);
    const spendableSet = new UTXOSet();
    for (const utxo of spendable) spendableSet.add(utxo);

    const spendableSat = spendableSet.getBalance();
    const totalSat = all.getBalance();
    return { spendableSat, pendingSat: totalSat - spendableSat, totalSat };
  } finally {
    keyManager.wipe();
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Resolve the fee rate, or refuse.
 *
 * There is no fallback constant on purpose. A hardcoded rate below the
 * network's relay minimum produces transactions the network drops with no
 * error the payer can see — the money still looks spendable, the payment never
 * arrives, and nothing in the wallet says why. Failing here is a message; a
 * guessed rate is a silent loss.
 *
 * The rate is rounded UP to a whole base unit per byte, because every consumer
 * of it — `estimateFeeForInputs` here, `buildTransaction` in core — multiplies
 * it inside a `BigInt`, and `BigInt(1.5)` is a RangeError thrown from deep
 * inside fee arithmetic, nowhere near the explorer response that produced it.
 * Up and not down: an extra base unit per byte costs a rounding error, while a
 * rate rounded below the relay minimum costs the whole transaction.
 */
async function resolveFeePerByte(
  requested: number | undefined,
  network: NetworkType,
  chain: ChainAccess
): Promise<number> {
  const rate =
    requested ?? (await (chain.fetchFeePerByte ?? fetchFeePerByte)(network));
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`feePerByte must be a positive number, got ${rate}`);
  }
  return Math.ceil(rate);
}

/**
 * The confirmation depth an output needs before this wallet spends it.
 *
 * 1 is the floor and 0 is refused rather than clamped. Spending an output still
 * in the mempool builds a chain on a parent the network may never keep: if the
 * parent is dropped, every descendant is invalid, and a wallet that does this
 * to its own change re-spends coins that no longer exist.
 */
function resolveMinConfirmations(requested: number | undefined): number {
  if (requested === undefined) return 1;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(
      `minConfirmations must be an integer of at least 1, got ${requested}` +
        ' — an unconfirmed output is not spendable'
    );
  }
  return requested;
}

async function discover(
  keyManager: KeyManager,
  network: NetworkType,
  chain: ChainAccess
): Promise<UTXO[]> {
  return await discoverUtxos(keyManager, network, chain.fetchAddressInfo ?? fetchAddressInfo);
}

async function loadSpendable(
  keyManager: KeyManager,
  wallet: WalletRef,
  chain: ChainAccess
): Promise<UTXO[]> {
  return await filterSpendable(await discover(keyManager, wallet.network, chain), wallet, chain);
}

/**
 * Narrow discovered outputs to the ones deep enough to spend.
 *
 * At depth 1 this is `confirmed` and costs no request. Deeper needs the chain
 * tip, which is fetched ONLY then: a wallet asking for the default should not
 * pay a round trip for a subtraction it does not do.
 */
async function filterSpendable(
  discovered: readonly UTXO[],
  wallet: WalletRef,
  chain: ChainAccess
): Promise<UTXO[]> {
  const minConfirmations = resolveMinConfirmations(wallet.minConfirmations);
  const confirmed = discovered.filter((utxo) => utxo.confirmed);
  if (minConfirmations <= 1) return confirmed;

  const tip = await (chain.fetchChainTip ?? fetchChainTip)(wallet.network);
  return confirmed.filter((utxo) => tip - utxo.blockHeight + 1 >= minConfirmations);
}

/**
 * The fee the built transaction pays, cross-checked against the fee selection
 * quoted for the same inputs.
 *
 * Both numbers are computed from the same dust rule, so they agree — and that
 * is exactly why the check is worth running: it holds only while the builder's
 * rule and `computeFeeAndChange`'s rule are the same rule. The day one of them
 * changes, this throws before signing instead of shipping a payment whose
 * displayed fee was a different number from the one the miner took.
 */
function feePaidBy(transaction: Transaction, selection: SelectedInputs): bigint {
  const totalIn = selection.selected.reduce((sum, utxo) => sum + utxo.value, 0n);
  const totalOut = transaction.outputs.reduce((sum, output) => sum + output.value, 0n);
  const actual = totalIn - totalOut;
  if (actual !== selection.fee) {
    throw new Error(
      `Refusing to send: transaction pays ${actual} but selection quoted ${selection.fee}`
    );
  }
  return actual;
}

/**
 * Sign every input with the key for ITS OWN previous output.
 *
 * Inputs are matched back to their UTXO by outpoint, never by position. The
 * builder happens to preserve order today; if it ever stopped, position-matching
 * would sign input i with input j's key and produce a transaction the network
 * rejects — after it was broadcast, with no local sign that anything was wrong.
 *
 * An address this key manager does not own throws here. That is the loud
 * failure: there is no fallback key, and signing with the wrong one is
 * indistinguishable from signing correctly until the network refuses it.
 */
function signEveryInput(
  transaction: Transaction,
  selected: readonly UTXO[],
  keyManager: KeyManager
): void {
  for (let i = 0; i < transaction.inputs.length; i++) {
    const input = transaction.inputs[i]!;
    const utxo = selected.find((u) => u.txid === input.txid && u.vout === input.vout);
    if (!utxo) {
      throw new Error(`No selected UTXO for input ${input.txid}:${input.vout}`);
    }
    if (!keyManager.ownsAddress(utxo.address)) {
      throw new Error(`Cannot sign for ${utxo.address}: not an address of this wallet`);
    }
    transaction.inputs[i] = {
      ...input,
      scriptSig: signInput(
        transaction,
        i,
        utxo.scriptPubKey,
        keyManager.getPrivateKeyForAddress(utxo.address)
      ),
    };
  }
}
