/**
 * Both ends of the social-payment network read the SAME constant.
 *
 * ## Why this is a source census and not a render test
 *
 * The property is "these two modules do not name the network independently",
 * and the failure it guards is one where BOTH sides work in isolation: the gate
 * correctly refuses mainnet, the view correctly renders whatever the gateway
 * returns, and the product is an empty history for every web visitor because
 * the two were asking about different chains. A unit test of either half passes
 * either way — `profile-route.test.ts` still passes with the view reverted,
 * which is exactly why this file exists.
 *
 * A render test would be the stronger form, but `packages/frontend` has no
 * component-test harness at all (no `.test.tsx`, no testing-library), and
 * standing one up for this is a bigger change than the fix. Reading the source
 * is the honest smaller mechanism: it cannot prove the view renders correctly,
 * only that it has not gone back to naming its own network — which is the
 * regression, and it names it in the failure message.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SOCIAL_PAY_NETWORK } from "./social-network";

const SRC = join(import.meta.dir, "..");

/**
 * The file's CODE, with comments removed.
 *
 * Load-bearing: the fixed modules explain what they no longer do, naming
 * `useWalletStore` and the old literal in prose. A census reading raw text
 * would match those explanations and report the regression it was written to
 * catch — which is how a gate ends up either permanently red or, once someone
 * "fixes" it by deleting the check, permanently vacuous.
 *
 * Whole-line `//` only, so a `//` inside a string literal survives.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function source(relativePath: string): string {
  const text = withoutComments(readFileSync(join(SRC, relativePath), "utf8"));
  // Vacuity floor. A moved or renamed file — or a comment stripper that ate the
  // whole file — would otherwise make every assertion below pass over an empty
  // string and gate nothing.
  expect(text.length).toBeGreaterThan(200);
  return text;
}

test("the constant is the network social payments actually run on", () => {
  // Pinned as a VALUE too, so lifting the mainnet restriction is a deliberate
  // edit here rather than something that happens to compile.
  expect(SOCIAL_PAY_NETWORK).toBe("testnet");
});

test("the pay gate reads the constant rather than a literal", () => {
  const gate = source("pay/profile-route.ts");
  expect(gate).toContain("SOCIAL_PAY_NETWORK");
  // The literal it replaced. Its return would mean the gate had started
  // deciding the network on its own again.
  expect(gate).not.toContain('network !== "testnet"');
});

test("the read-only history reads the constant, not the wallet store", () => {
  const view = source("ui/components/ReadOnlyWalletView.tsx");
  expect(view).toContain("SOCIAL_PAY_NETWORK");
  // THE regression, named. No wallet initializes on this surface — that is what
  // makes it read-only — so the store never leaves its `mainnet` default, and
  // reading it here asks about the one network that structurally has nothing to
  // show.
  expect(view).not.toContain("useWalletStore");
});
