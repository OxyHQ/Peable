/**
 * Tests for the minimal multisig-wallet path: build an unsigned spend from
 * a multisig UTXO, export it as a signing request, have two independent
 * "devices" (raw keypairs, simulating separate cosigner hardware) sign it
 * without ever seeing each other's private key, then combine and finalize.
 *
 * Uses the same real, reproducible fixture (fixed keys, fixed 2-of-3 redeem
 * script) as @fairco.in/core's own multisig-transaction.test.ts, so the
 * unsigned draft this test builds is byte-identical to that suite's.
 *
 * NOTE (API deviation from the task brief, which targeted @fairco.in/core
 * 0.2.0): the installed 0.3.0 `BuildMultisigSpendParams` has NO `m` field (m
 * is derived from the redeem script), so the fixture omits it. The signer path
 * additionally takes the out-of-band input value(s) and network, and returns
 * the decoded spend summary alongside the partial signature -- the mandatory
 * anti-blind-signing requirement -- so the assertions below unwrap `.partial`.
 */
import { describe, test, expect } from "bun:test";
import {
  hexToBytes,
  bytesToHex,
  encodeAddress,
  hash160,
  createP2SHScript,
  MAINNET,
  createMultisigRedeemScript,
  multisigAddress,
  deserializeTransaction,
  serializeTransaction,
  type BuildMultisigSpendParams,
} from "@fairco.in/core";
import {
  buildMultisigSendDraft,
  exportSigningRequest,
  decodeMultisigSpend,
  signMultisigSendRequest,
  finalizeMultisigSend,
} from "./multisig";

const PRIV1 = hexToBytes("01".repeat(32));
const PRIV3 = hexToBytes("03".repeat(32));
const PUB1 = hexToBytes("031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f");
const PUB2 = hexToBytes("024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766");
const PUB3 = hexToBytes("02531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337");
const REDEEM_SCRIPT = createMultisigRedeemScript(2, [PUB1, PUB2, PUB3]);
const MULTISIG_ADDRESS = multisigAddress(REDEEM_SCRIPT, MAINNET);
const PUB2_ADDRESS = encodeAddress(hash160(PUB2), MAINNET.pubKeyHash);
const INPUT_VALUE = 10_000_000n;

function baseParams(): BuildMultisigSpendParams {
  return {
    utxos: [
      {
        txid: "bb".repeat(32),
        vout: 0,
        value: INPUT_VALUE,
        scriptPubKey: createP2SHScript(hash160(REDEEM_SCRIPT)),
      },
    ],
    redeemScript: REDEEM_SCRIPT,
    recipients: [{ address: PUB2_ADDRESS, value: 4_000_000n }],
    changeAddress: MULTISIG_ADDRESS,
    feePerByte: 10n,
    network: MAINNET,
  };
}

describe("buildMultisigSendDraft", () => {
  test("produces the exact real unsigned draft", () => {
    const draft = buildMultisigSendDraft(baseParams());
    expect(draft.tx.outputs[0].value).toBe(4_000_000n);
    expect(draft.tx.outputs[1].value).toBe(5_996_230n);
    expect(bytesToHex(draft.redeemScript)).toBe(bytesToHex(REDEEM_SCRIPT));
  });

  test("rejects a draft spanning more than one multisig UTXO", () => {
    const params = baseParams();
    params.utxos = [...params.utxos, { ...params.utxos[0], vout: 1 }];
    expect(() => buildMultisigSendDraft(params)).toThrow(/exactly one/);
  });
});

describe("decodeMultisigSpend (anti-blind-signing)", () => {
  test("decodes every recipient/change output and the fee for confirmation", () => {
    const request = exportSigningRequest(buildMultisigSendDraft(baseParams()));
    const summary = decodeMultisigSpend(request, [INPUT_VALUE], MAINNET);

    expect(summary.outputs).toEqual([
      { address: PUB2_ADDRESS, value: 4_000_000n },
      { address: MULTISIG_ADDRESS, value: 5_996_230n },
    ]);
    expect(summary.totalInput).toBe(INPUT_VALUE);
    expect(summary.totalOutput).toBe(9_996_230n);
    expect(summary.fee).toBe(3_770n);
    expect(summary.inputCount).toBe(1);
  });

  test("rejects a mismatched out-of-band input-value count", () => {
    const request = exportSigningRequest(buildMultisigSendDraft(baseParams()));
    expect(() => decodeMultisigSpend(request, [INPUT_VALUE, INPUT_VALUE], MAINNET)).toThrow(
      /expected 1 input value/,
    );
  });

  test("rejects a request whose outputs exceed the provided input value", () => {
    const request = exportSigningRequest(buildMultisigSendDraft(baseParams()));
    expect(() => decodeMultisigSpend(request, [1_000n], MAINNET)).toThrow(/over-spend/);
  });
});

describe("exportSigningRequest / signMultisigSendRequest / finalizeMultisigSend", () => {
  test("two independent cosigner devices produce the exact real finalized transaction", () => {
    const draft = buildMultisigSendDraft(baseParams());
    const request = exportSigningRequest(draft);

    // Device 1: only ever sees PRIV1. Device 3: only ever sees PRIV3.
    // Neither device's function call has access to the other's key.
    const signed1 = signMultisigSendRequest(request, PRIV1, PUB1, [INPUT_VALUE], MAINNET);
    const signed3 = signMultisigSendRequest(request, PRIV3, PUB3, [INPUT_VALUE], MAINNET);

    // The signer is handed the decoded summary, so it can confirm what it signed.
    expect(signed1.summary.fee).toBe(3_770n);
    expect(signed1.summary.outputs[0]).toEqual({ address: PUB2_ADDRESS, value: 4_000_000n });

    expect(signed1.partial.pubkey).toBe(PUB1);
    expect(bytesToHex(signed1.partial.signature)).toBe(
      "30450221009fb3526a098539a06a31cdf549f22b851025b8fca09d377b85592c0af1a3603a022063a1a91a073e65a4290ddb042122d42c959088424ae64aa344db8dac85272dc201",
    );
    expect(bytesToHex(signed3.partial.signature)).toBe(
      "3044022036cf948a33d4bb0decc58a4df0617a1e23666df7b0a8ee6ae9c820b138f16dcf0220050f3cf171c492acae16432a83be20760a8a5e37df2c9b4993b5f102d9255b8701",
    );

    const { rawTx, txid } = finalizeMultisigSend(draft, [signed1.partial, signed3.partial]);
    expect(bytesToHex(rawTx)).toBe(
      "0100000001bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb00000000fdfd00004830450221009fb3526a098539a06a31cdf549f22b851025b8fca09d377b85592c0af1a3603a022063a1a91a073e65a4290ddb042122d42c959088424ae64aa344db8dac85272dc201473044022036cf948a33d4bb0decc58a4df0617a1e23666df7b0a8ee6ae9c820b138f16dcf0220050f3cf171c492acae16432a83be20760a8a5e37df2c9b4993b5f102d9255b87014c695221031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f21024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d07662102531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe33753aeffffffff0200093d00000000001976a914ebc0ee0b2ab9e8277a600c251475e22a3241a1c188acc67e5b000000000017a914ae79902ae33900b679c76ced8576362e4abb15e88700000000",
    );
    expect(txid).toBe("aac86bdcb7ec8ed28a9322e2c078a9d730d52613576ae3f7f7db623788c4a241");

    // The finalized transaction round-trips through the wire format.
    const parsed = deserializeTransaction(rawTx);
    expect(bytesToHex(serializeTransaction(parsed))).toBe(bytesToHex(rawTx));
  });

  test("the serialized signing request carries no private key material", () => {
    const request = exportSigningRequest(buildMultisigSendDraft(baseParams()));
    const requestJson = JSON.stringify(request);
    expect(requestJson).not.toContain(bytesToHex(PRIV1));
    expect(requestJson).not.toContain(bytesToHex(PRIV3));
  });
});

describe("finalizeMultisigSend verifies partial signatures at combine time", () => {
  test("rejects a partial signature mislabeled with the wrong cosigner pubkey", () => {
    const draft = buildMultisigSendDraft(baseParams());
    const request = exportSigningRequest(draft);
    const signed1 = signMultisigSendRequest(request, PRIV1, PUB1, [INPUT_VALUE], MAINNET);
    const signed3 = signMultisigSendRequest(request, PRIV3, PUB3, [INPUT_VALUE], MAINNET);

    // PRIV1's signature relabeled as if it were PUB3's -- exactly the bad
    // contribution the combine-time verification exists to catch.
    const mislabeled = { pubkey: PUB3, signature: signed1.partial.signature };
    expect(() => finalizeMultisigSend(draft, [signed1.partial, mislabeled])).toThrow(
      /does not verify/,
    );
    // The genuine set still finalizes.
    expect(() => finalizeMultisigSend(draft, [signed1.partial, signed3.partial])).not.toThrow();
  });

  test("rejects a corrupted partial signature", () => {
    const draft = buildMultisigSendDraft(baseParams());
    const request = exportSigningRequest(draft);
    const signed1 = signMultisigSendRequest(request, PRIV1, PUB1, [INPUT_VALUE], MAINNET);
    const signed3 = signMultisigSendRequest(request, PRIV3, PUB3, [INPUT_VALUE], MAINNET);

    const tampered = new Uint8Array(signed3.partial.signature);
    tampered[tampered.length - 2] ^= 0xff;
    const corrupted = { pubkey: PUB3, signature: tampered };
    expect(() => finalizeMultisigSend(draft, [signed1.partial, corrupted])).toThrow(
      /does not verify/,
    );
  });
});
