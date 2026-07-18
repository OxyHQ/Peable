/**
 * FAIRWallet's minimal multisig-wallet path, consuming `@fairco.in/core`'s
 * Layer 1 multisig primitives. Watch-address registration (this file, added
 * first) lets the wallet notice funds sent to a multisig address it is a
 * cosigner for; spend building/signing/combining is added alongside it in a
 * later change to this file.
 */
import {
  multisigAddress,
  bytesToHex,
  buildMultisigSpend,
  signMultisigInput,
  assembleMultisigScriptSig,
  computeMultisigSigHash,
  verifyPartialSignature,
  serializeMultisigSigningRequest,
  deserializeMultisigSigningRequest,
  serializeTransaction,
  hashTransaction,
  extractAddressFromScript,
  type NetworkConfig,
  type Transaction,
  type BuildMultisigSpendParams,
  type PartialSignature,
  type SerializedMultisigSigningRequest,
} from "@fairco.in/core";
import type { Database } from "../storage/database";
import type { KeyManager } from "./key-manager";

/**
 * Compute the P2SH address for a redeem script, persist it as a watch
 * address, and register it with the KeyManager so it is owned (and
 * therefore Bloom-filter-watched) immediately -- without waiting for a
 * wallet restart.
 */
export async function registerMultisigWatchAddress(
  database: Database,
  keyManager: KeyManager,
  redeemScript: Uint8Array,
  network: NetworkConfig,
  label = "",
): Promise<string> {
  const address = multisigAddress(redeemScript, network);
  await database.insertWatchAddress(address, bytesToHex(redeemScript), label);
  keyManager.registerWatchAddress(address);
  return address;
}

/**
 * Restore every persisted watch address into the KeyManager. Called at
 * wallet init, alongside `keyManager.restoreCursors`, so multisig addresses
 * registered in a previous session are owned and watched again immediately.
 */
export async function loadWatchAddressesIntoKeyManager(
  database: Database,
  keyManager: KeyManager,
): Promise<void> {
  const rows = await database.getWatchAddresses();
  for (const row of rows) {
    keyManager.registerWatchAddress(row.address);
  }
}

/** An unsigned single-input multisig spend, ready to be signed by cosigners. */
export interface MultisigSendDraft {
  tx: Transaction;
  redeemScript: Uint8Array;
}

/** One decoded destination of a spend: where value is going and how much. */
export interface MultisigSpendOutput {
  address: string;
  value: bigint;
}

/**
 * A human-confirmable decoding of what a multisig spend authorizes. This is
 * the anti-blind-signing surface: before a cosigner produces a partial
 * signature, the caller/UI can read exactly which addresses receive how much
 * and what fee is being paid, and decline if it does not match intent.
 *
 * `outputs` (recipients AND any change back to the multisig address) come from
 * the transaction's own outputs. `fee` cannot: FairCoin's legacy sighash does
 * NOT commit input amounts (no BIP143), so the input value(s) are NOT present
 * in the unsigned transaction and MUST be supplied out-of-band from the known
 * UTXO set (`inputValues`). Trusting an input amount asserted inside the
 * unsigned tx would let a malicious coordinator hide the true fee.
 */
export interface MultisigSpendSummary {
  /** Every output of the spend, decoded to an address + amount. Includes change. */
  outputs: MultisigSpendOutput[];
  /** Sum of the out-of-band input value(s) this spend consumes. */
  totalInput: bigint;
  /** Sum of every output value. */
  totalOutput: bigint;
  /** Miner fee = totalInput - totalOutput. */
  fee: bigint;
  /** Number of inputs the spend consumes. */
  inputCount: number;
}

/** A cosigner's partial signature plus the decoded summary of what it signed. */
export interface SignedMultisigPartial {
  /**
   * The relay payload: a pubkey + DER signature. This -- and ONLY this -- is
   * what a cosigner device sends back to the coordinator; it carries no private
   * key material.
   */
  partial: PartialSignature;
  /** What was actually signed, decoded so the caller can confirm it authorized
   *  the intended recipients, amounts, and fee. */
  summary: MultisigSpendSummary;
}

/**
 * Build an unsigned multisig spend. Limited to spending exactly ONE
 * multisig UTXO -- multi-input coordination across several multisig UTXOs
 * is out of scope for this minimal path (see the module doc comment).
 */
export function buildMultisigSendDraft(params: BuildMultisigSpendParams): MultisigSendDraft {
  if (params.utxos.length !== 1) {
    throw new Error(
      "buildMultisigSendDraft supports exactly one multisig UTXO input; multi-input multisig spends are not yet supported",
    );
  }
  const tx = buildMultisigSpend(params);
  return { tx, redeemScript: params.redeemScript };
}

/**
 * Export a draft as a signing request a cosigner device can consume. Carries
 * no private key material -- only the unsigned tx, the input index, and the
 * redeem script.
 */
export function exportSigningRequest(draft: MultisigSendDraft): SerializedMultisigSigningRequest {
  return serializeMultisigSigningRequest({
    tx: draft.tx,
    inputIndex: 0,
    redeemScript: draft.redeemScript,
  });
}

/**
 * Decode a signing request into a human-confirmable summary of what signing it
 * would authorize -- recipients (and change), each amount, and the fee. Call
 * this BEFORE `signMultisigSendRequest` to show the user what they are about to
 * approve; it is the mechanism that makes blind signing impossible.
 *
 * `inputValues` must hold one value per transaction input, sourced out-of-band
 * from the known UTXO set (see {@link MultisigSpendSummary}). Throws if the
 * count is wrong, if an output cannot be decoded to an address (an unreadable
 * destination is refused rather than summarized blindly), or if the outputs
 * exceed the input value(s) (an over-spend / wrong input values).
 */
export function decodeMultisigSpend(
  serializedRequest: SerializedMultisigSigningRequest,
  inputValues: bigint[],
  network: NetworkConfig,
): MultisigSpendSummary {
  const { tx } = deserializeMultisigSigningRequest(serializedRequest);
  if (inputValues.length !== tx.inputs.length) {
    throw new Error(
      `decodeMultisigSpend: expected ${tx.inputs.length} input value(s) (one per input, sourced out-of-band from the known UTXO set), got ${inputValues.length}`,
    );
  }
  const outputs = tx.outputs.map((out, index): MultisigSpendOutput => {
    const address = extractAddressFromScript(out.scriptPubKey, network);
    if (address === null) {
      throw new Error(
        `decodeMultisigSpend: output ${index} has a non-standard scriptPubKey that cannot be decoded to an address; refusing to summarize an unreadable destination`,
      );
    }
    return { address, value: out.value };
  });
  const totalInput = inputValues.reduce((sum, value) => sum + value, 0n);
  const totalOutput = outputs.reduce((sum, out) => sum + out.value, 0n);
  if (totalOutput > totalInput) {
    throw new Error(
      "decodeMultisigSpend: outputs exceed the provided input value(s); the request over-spends or the out-of-band input values are wrong",
    );
  }
  return {
    outputs,
    totalInput,
    totalOutput,
    fee: totalInput - totalOutput,
    inputCount: tx.inputs.length,
  };
}

/**
 * Sign a received request with THIS device's own private key. There is NO
 * blind-signing path: the request is first decoded (via `decodeMultisigSpend`)
 * into a summary that is returned alongside the signature, so the caller can
 * verify it authorized the intended recipients/amounts/fee, and an unreadable
 * or over-spending request is rejected before the private key is ever used.
 *
 * Returns only a `PartialSignature` (pubkey + DER signature) plus the key-free
 * summary -- the private key argument is never read back out in any form.
 */
export function signMultisigSendRequest(
  serializedRequest: SerializedMultisigSigningRequest,
  privateKey: Uint8Array,
  pubkey: Uint8Array,
  inputValues: bigint[],
  network: NetworkConfig,
): SignedMultisigPartial {
  const summary = decodeMultisigSpend(serializedRequest, inputValues, network);
  const { tx, inputIndex, redeemScript } = deserializeMultisigSigningRequest(serializedRequest);
  const signature = signMultisigInput(tx, inputIndex, redeemScript, privateKey);
  return { partial: { pubkey, signature }, summary };
}

/**
 * Combine `m` (or more) partial signatures into the final scriptSig and
 * produce the broadcastable raw transaction + its txid.
 *
 * Every partial signature is first verified against its claimed pubkey over the
 * correct sighash. `assembleMultisigScriptSig` is a pure serializer that does
 * NO cryptographic checking, so a mislabeled, foreign, or corrupted partial
 * would otherwise flow straight into an unspendable scriptSig; verifying here
 * -- exactly where the coordinator collects contributions -- rejects it loudly.
 */
export function finalizeMultisigSend(
  draft: MultisigSendDraft,
  signatures: PartialSignature[],
): { rawTx: Uint8Array; txid: string } {
  const sighash = computeMultisigSigHash(draft.tx, 0, draft.redeemScript);
  for (const { pubkey, signature } of signatures) {
    if (!verifyPartialSignature(signature, pubkey, sighash)) {
      throw new Error(
        `finalizeMultisigSend: partial signature for pubkey ${bytesToHex(pubkey)} does not verify over the transaction sighash; refusing to assemble a scriptSig from an unverified partial`,
      );
    }
  }
  const scriptSig = assembleMultisigScriptSig(signatures, draft.redeemScript);
  const finalTx: Transaction = {
    ...draft.tx,
    inputs: [{ ...draft.tx.inputs[0], scriptSig }],
  };
  const rawTx = serializeTransaction(finalTx);
  const txid = hashTransaction(finalTx);
  return { rawTx, txid };
}
