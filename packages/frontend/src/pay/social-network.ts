/**
 * The ONE network social payments run on.
 *
 * ## Why this is a constant and not a literal in two places
 *
 * `decideProfilePayAction` refuses to send unless the wallet is on this
 * network, and `ReadOnlyWalletView` asks the gateway for the payments a person
 * has received. Those are the two ends of the same fact, and they disagreed:
 * the gate hard-coded `"testnet"` while the read-only view took the wallet
 * store's network — which on web is the store's DEFAULT (`"mainnet"`), because
 * no wallet initializes on that surface at all, which is the entire point of it.
 *
 * So every web visitor was shown an empty history: the app can only create
 * social payments on testnet, and the view only ever asked about mainnet.
 * Nothing errored, nothing logged, and the screen looked exactly like a person
 * who has simply never been paid.
 *
 * Reading the same constant is what stops the two ends drifting again. It does
 * not decide product: a network selector can be layered on top whenever the
 * restriction below is lifted, and lifting it is a one-line change here.
 *
 * ## Why testnet
 *
 * Rotating the Oxy identity key desyncs the shared key slot, so a payer can
 * send to addresses the recipient can neither see nor spend — silent, permanent
 * loss. Testnet only until that is fixed upstream.
 */
import type { NetworkType } from "@fairco.in/core";

export const SOCIAL_PAY_NETWORK: NetworkType = "testnet";
