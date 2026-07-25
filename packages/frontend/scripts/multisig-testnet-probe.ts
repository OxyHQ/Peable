#!/usr/bin/env bun
/**
 * Layer 1 multisig — live testnet probe harness (plan Task 10, Step 3).
 *
 * The security review (Task 10, Step 2) proved the CRYPTO is byte-correct. It
 * did NOT prove that FairCoin Core's node accepts a standard BIP16 P2SH +
 * BIP11 OP_CHECKMULTISIG script as relay-standard / consensus-valid — some
 * Bitcoin forks alter IsStandard() policy. This harness runs the real spend
 * path end to end on TESTNET so that assumption can be proven (or disproven):
 *
 *   1. `setup`      — generate a real 2-of-3 testnet multisig, print its
 *                     address to fund from a faucet. Keys are written to a
 *                     gitignored state file (TESTNET keys only, never mainnet).
 *   2. (fund)       — send testnet FAIR to the printed address; note the
 *                     funding txid:vout and its value in satoshis.
 *   3. `spend`      — build + sign (cosigners 1 & 2) + combine + finalize a
 *                     real spend of that UTXO via FAIRWallet's own multisig
 *                     path, and print the broadcastable raw transaction + txid.
 *   4. `broadcast`  — relay the raw tx to a testnet node (JSON-RPC) if one is
 *                     configured, otherwise print the ways to broadcast it.
 *
 * The probe passes when the broadcast is relayed, confirms in a block, and the
 * wallet's SPV receive path recognizes the multisig UTXO as spent. Until then,
 * multisig stays BLOCKED for real-money use (plan Task 10, Step 4).
 *
 * Run: `bun scripts/multisig-testnet-probe.ts <setup|spend|broadcast|help>`
 *
 * This is a standalone bun script: it imports `@fairco.in/core` (pure) and
 * FAIRWallet's pure `src/wallet/multisig.ts` wrapper — no React Native, no SPV
 * client — so it runs outside the app. Broadcast is the only step that needs a
 * live network path, kept deliberately pluggable.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as secp256k1 from "@noble/secp256k1";
import {
  createMultisigRedeemScript,
  multisigAddress,
  publicKeyToAddress,
  hash160,
  bytesToHex,
  hexToBytes,
  getNetwork,
  type UTXO,
} from "@fairco.in/core";
import {
  buildMultisigSendDraft,
  exportSigningRequest,
  signMultisigSendRequest,
  finalizeMultisigSend,
} from "../src/wallet/multisig";

// --- Constants -------------------------------------------------------------

const NETWORK = getNetwork("testnet");
const STATE_FILE = new URL("../.multisig-probe.testnet.json", import.meta.url)
  .pathname;
const THRESHOLD = 2; // m
const COSIGNERS = 3; // n
const DEFAULT_FEE_PER_BYTE = 10n;
/** Satoshis held back from the recipient amount to cover fee + change when
 *  `--amount` is not supplied. A probe never optimizes fees; it just needs a
 *  valid spend. */
const DEFAULT_FEE_RESERVE = 5_000n;

/** Persisted probe identity. Holds TESTNET private keys — gitignored, never
 *  mainnet, never a real user's funds. */
interface ProbeState {
  network: "testnet";
  m: number;
  n: number;
  /** Cosigner private keys, hex. TESTNET ONLY. */
  privateKeys: string[];
  /** Cosigner public keys, compressed, hex. */
  publicKeys: string[];
  /** The shared 2-of-3 redeem script, hex. */
  redeemScript: string;
  /** The P2SH testnet address funds are sent to. */
  multisigAddress: string;
}

// --- State + helpers -------------------------------------------------------

function loadState(): ProbeState {
  if (!existsSync(STATE_FILE)) {
    throw new Error(
      `No probe state at ${STATE_FILE}. Run \`bun scripts/multisig-testnet-probe.ts setup\` first.`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as ProbeState).network !== "testnet"
  ) {
    throw new Error(`Probe state at ${STATE_FILE} is malformed.`);
  }
  return parsed as ProbeState;
}

function saveState(state: ProbeState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** The BIP16 P2SH scriptPubKey for a redeem script: OP_HASH160 <20> OP_EQUAL.
 *  `buildMultisigSpend` validates the UTXO's scriptPubKey against exactly this,
 *  so it must match what a funded output actually carries. */
function p2shScriptPubKey(redeemScript: Uint8Array): Uint8Array {
  return new Uint8Array([0xa9, 0x14, ...hash160(redeemScript), 0x87]);
}

/** Parse `key=value`/`--key value` argv into a lookup. */
function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, "true");
    } else {
      flags.set(key, next);
      i++;
    }
  }
  return flags;
}

function requireFlag(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (value === undefined) {
    throw new Error(`Missing required --${key}`);
  }
  return value;
}

// --- Commands --------------------------------------------------------------

function cmdSetup(): void {
  if (existsSync(STATE_FILE)) {
    throw new Error(
      `Probe state already exists at ${STATE_FILE}. Delete it to regenerate a fresh multisig, or reuse it.`,
    );
  }
  const privateKeys: Uint8Array[] = [];
  const publicKeys: Uint8Array[] = [];
  for (let i = 0; i < COSIGNERS; i++) {
    const priv = secp256k1.utils.randomPrivateKey();
    privateKeys.push(priv);
    publicKeys.push(secp256k1.getPublicKey(priv, true));
  }
  const redeemScript = createMultisigRedeemScript(THRESHOLD, publicKeys);
  const address = multisigAddress(redeemScript, NETWORK);

  const state: ProbeState = {
    network: "testnet",
    m: THRESHOLD,
    n: COSIGNERS,
    privateKeys: privateKeys.map((k) => bytesToHex(k)),
    publicKeys: publicKeys.map((k) => bytesToHex(k)),
    redeemScript: bytesToHex(redeemScript),
    multisigAddress: address,
  };
  saveState(state);

  console.log(`\n2-of-3 testnet multisig created (state → ${STATE_FILE}, gitignored).\n`);
  console.log(`  multisig address : ${address}`);
  console.log(`  redeem script    : ${state.redeemScript}`);
  console.log(`  P2SH scriptPubKey: ${bytesToHex(p2shScriptPubKey(redeemScript))}`);
  console.log(`  cosigner pubkeys : ${state.publicKeys.join("\n                     ")}`);
  console.log(
    `  cosigner1 P2PKH  : ${publicKeyToAddress(publicKeys[0], NETWORK)} (an alternative --to target)`,
  );
  console.log(
    `\nNext: fund the address above from a testnet faucet, then run:\n` +
      `  bun scripts/multisig-testnet-probe.ts spend --utxo <fundingTxid>:<vout>:<satoshis>\n`,
  );
}

function cmdSpend(flags: Map<string, string>): void {
  const state = loadState();
  const redeemScript = hexToBytes(state.redeemScript);

  // --utxo txid:vout:satoshis (the funding output paying the multisig address)
  const utxoParts = requireFlag(flags, "utxo").split(":");
  if (utxoParts.length !== 3) {
    throw new Error("--utxo must be <txid>:<vout>:<satoshis>");
  }
  const [txid, voutStr, satsStr] = utxoParts;
  const vout = Number.parseInt(voutStr, 10);
  const value = BigInt(satsStr);
  if (!Number.isInteger(vout) || vout < 0) {
    throw new Error(`Invalid vout: ${voutStr}`);
  }
  if (value <= 0n) {
    throw new Error(`Invalid satoshi value: ${satsStr}`);
  }

  // Destination defaults to the multisig address itself (a self-spend also
  // exercises the SPV receive path recognizing the change/output as ours).
  const recipient = flags.get("to") ?? state.multisigAddress;
  const feePerByte = flags.has("fee-per-byte")
    ? BigInt(requireFlag(flags, "fee-per-byte"))
    : DEFAULT_FEE_PER_BYTE;
  const amount = flags.has("amount")
    ? BigInt(requireFlag(flags, "amount"))
    : value - DEFAULT_FEE_RESERVE;
  if (amount <= 0n) {
    throw new Error(
      `Recipient amount ${amount} <= 0. UTXO too small for the default fee reserve; pass an explicit --amount.`,
    );
  }

  const utxo: UTXO = {
    txid,
    vout,
    value,
    scriptPubKey: p2shScriptPubKey(redeemScript),
  };

  const draft = buildMultisigSendDraft({
    utxos: [utxo],
    redeemScript,
    recipients: [{ address: recipient, value: amount }],
    changeAddress: state.multisigAddress,
    feePerByte,
    network: NETWORK,
  });

  // Two cosigners (m = 2) sign independently, as separate devices would.
  const request = exportSigningRequest(draft);
  const inputValues = [value];
  const signed1 = signMultisigSendRequest(
    request,
    hexToBytes(state.privateKeys[0]),
    hexToBytes(state.publicKeys[0]),
    inputValues,
    NETWORK,
  );
  const signed2 = signMultisigSendRequest(
    request,
    hexToBytes(state.privateKeys[1]),
    hexToBytes(state.publicKeys[1]),
    inputValues,
    NETWORK,
  );

  const { rawTx, txid: spendTxid } = finalizeMultisigSend(draft, [
    signed1.partial,
    signed2.partial,
  ]);

  const summary = signed1.summary;
  console.log(`\nSigned 2-of-3 multisig spend (cosigners 1 & 2):\n`);
  console.log(`  spend txid : ${spendTxid}`);
  console.log(`  inputs     : ${summary.inputCount} (value ${summary.totalInput} sat)`);
  for (const out of summary.outputs) {
    console.log(`  output     : ${out.value} sat → ${out.address}`);
  }
  console.log(`  fee        : ${summary.fee} sat`);
  console.log(`\n  raw tx (broadcast this):\n  ${bytesToHex(rawTx)}\n`);
  console.log(
    `Next: broadcast it:\n` +
      `  bun scripts/multisig-testnet-probe.ts broadcast --raw ${bytesToHex(rawTx)}\n`,
  );
}

async function cmdBroadcast(flags: Map<string, string>): Promise<void> {
  const rawHex = requireFlag(flags, "raw");
  // Validate it is hex before doing anything with it.
  hexToBytes(rawHex);

  const rpcUrl = process.env.FAIRCOIN_TESTNET_RPC_URL;
  if (rpcUrl === undefined) {
    console.log(
      `\nNo FAIRCOIN_TESTNET_RPC_URL set — printing broadcast options instead.\n\n` +
        `Broadcast the raw transaction any of these ways:\n` +
        `  1. Testnet node RPC:\n` +
        `       export FAIRCOIN_TESTNET_RPC_URL=http://127.0.0.1:46375\n` +
        `       export FAIRCOIN_TESTNET_RPC_AUTH=user:pass   # optional basic auth\n` +
        `       bun scripts/multisig-testnet-probe.ts broadcast --raw <hex>\n` +
        `  2. Node CLI:  faircoin-cli -testnet sendrawtransaction <hex>\n` +
        `  3. FAIRWallet's own SPV client (SPVClient.broadcastTransaction) from\n` +
        `     inside the app / a dev console, which is the exact path a real\n` +
        `     spend takes.\n\n` +
        `  raw tx: ${rawHex}\n`,
    );
    return;
  }

  const auth = process.env.FAIRCOIN_TESTNET_RPC_AUTH;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== undefined) {
    headers.authorization = `Basic ${Buffer.from(auth).toString("base64")}`;
  }
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "1.0",
      id: "multisig-probe",
      method: "sendrawtransaction",
      params: [rawHex],
    }),
  });
  const body: unknown = await response.json();
  const result = body as { result?: string; error?: { message?: string } };
  if (!response.ok || result.error) {
    throw new Error(
      `sendrawtransaction rejected: ${result.error?.message ?? `HTTP ${response.status}`}`,
    );
  }
  console.log(`\nBroadcast accepted by the node. txid: ${result.result}\n`);
  console.log(
    `Probe verification: confirm this txid lands in a testnet block and that ` +
      `the wallet's SPV path recognizes the multisig UTXO as spent.\n`,
  );
}

function cmdHelp(): void {
  console.log(
    `Layer 1 multisig — testnet probe (plan Task 10, Step 3)\n\n` +
      `  bun scripts/multisig-testnet-probe.ts setup\n` +
      `      Generate a 2-of-3 testnet multisig; print its address to fund.\n\n` +
      `  bun scripts/multisig-testnet-probe.ts spend --utxo <txid>:<vout>:<sats> \\\n` +
      `      [--to <address>] [--amount <sats>] [--fee-per-byte <sats>]\n` +
      `      Build + sign (cosigners 1&2) + finalize a spend; print raw tx.\n` +
      `      --to defaults to the multisig address (self-spend).\n\n` +
      `  bun scripts/multisig-testnet-probe.ts broadcast --raw <hex>\n` +
      `      Relay via FAIRCOIN_TESTNET_RPC_URL (JSON-RPC sendrawtransaction),\n` +
      `      or print broadcast options if no node is configured.\n\n` +
      `  A P2PKH testnet address for cosigner 1 (an alternative --to target):\n` +
      `      derived at runtime via publicKeyToAddress; see setup output for pubkeys.\n`,
  );
}

// --- Entry point -----------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (command) {
    case "setup":
      cmdSetup();
      break;
    case "spend":
      cmdSpend(flags);
      break;
    case "broadcast":
      await cmdBroadcast(flags);
      break;
    case "help":
    case undefined:
      cmdHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}. Run \`help\`.`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nprobe failed: ${message}\n`);
  process.exit(1);
});
