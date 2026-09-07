/**
 * What a scanned QR turned out to be, and how to tell.
 *
 * Lives beside `payment-request.ts` rather than inside `QRScanner.tsx` for the
 * same reason that one does: it is pure parsing with a grammar of its own, and
 * keeping it out of the component makes it testable without standing up React
 * Native and expo-camera.
 */
import { parseFairCoinURI } from "@fairco.in/core";
import { parsePaymentRequest } from "./payment-request";
import type { ParsedPaymentRequest } from "./payment-request";

/**
 * A single `string` return could only ever mean "an address", which is why the
 * scanner used to reject Peable's OWN checkout QR: `checkout.peable.to` renders
 * a `peable://pay?...` request, and there was no shape in which to report it.
 */
export type ScannedCode =
  | {
      kind: "address";
      address: string;
      /** Decimal FAIR from a `faircoin:` URI's `amount`, when it carried one. */
      amount?: string;
    }
  | { kind: "payment-request"; request: ParsedPaymentRequest };

/**
 * Classify a scanned QR string. Supports, in order:
 *   peable://pay?intent=…&secret=…   (a Gateway payment request)
 *   faircoin:FxxxxAddress?amount=1.0 (BIP21-style, amount preserved)
 *   faircoin:FxxxxAddress
 *   FxxxxAddress / TxxxxAddress      (raw mainnet / testnet)
 *
 * Both URI forms delegate to the parsers that already own their grammar —
 * `parsePaymentRequest` (which validates the intent id, secret, address and
 * network together) and `@fairco.in/core`'s `parseFairCoinURI` — rather than
 * re-implementing them here. The hand-rolled `faircoin:` branch this replaced
 * threw the `amount` away.
 */
export function parseScannedData(data: string): ScannedCode | null {
  const trimmed = data.trim();

  const request = parsePaymentRequest(trimmed);
  if (request) {
    return { kind: "payment-request", request };
  }

  const uri = parseFairCoinURI(trimmed);
  if (uri) {
    return uri.amount === null
      ? { kind: "address", address: uri.address }
      : { kind: "address", address: uri.address, amount: uri.amount };
  }

  // Raw address starting with F (mainnet) or T (testnet)
  if (
    (trimmed.startsWith("F") || trimmed.startsWith("T")) &&
    trimmed.length >= 25 &&
    trimmed.length <= 36
  ) {
    return { kind: "address", address: trimmed };
  }

  return null;
}
