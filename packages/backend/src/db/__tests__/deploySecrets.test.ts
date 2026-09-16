import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every variable `config.ts` reads is either SYNCED by the deploy or listed here
 * with a reason.
 *
 * ## The failure this exists to stop, which already happened
 *
 * `deploy-aws.yml`'s secret-sync step carries a comment saying "the list is the
 * secrets the `peable` task definition actually consumes. Adding a new one means
 * adding it here, or it never reaches SSM." That sentence was true and nothing
 * enforced it, so when the card rail landed its six variables were not added —
 * and the rail was **unreachable in production** while every test, every build
 * and every deploy stayed green.
 *
 * The silence is not incidental, it is designed in. `resolveStripeEnabled` is a
 * conjunction: with none of the six set it returns `false` at the FIRST check,
 * so it does not even reach the branch that warns about an incomplete
 * configuration. The rail is off, `resolveProvider` answers "this rail is not
 * configured", `/v1/refunds` answers 503 — every one of which is the correct
 * behaviour for a rail nobody switched on, and indistinguishable from a rail
 * somebody meant to switch on and could not.
 *
 * ## Why an explicit ledger rather than "sync everything"
 *
 * Most of what `config.ts` reads is not a secret and does not belong in SSM as a
 * SecureString. But "not a secret" is a DECISION about each name, and a name
 * nobody has decided about is exactly what went missing. So an unlisted,
 * unsynced variable fails the build, and the fix is either a sync line or one
 * line here saying why not — the same discipline the schema gates apply to an id
 * column with no foreign key.
 *
 * ## What this does NOT prove
 *
 * Writing a parameter to SSM does not put it in the container. The `peable` task
 * definition has to reference it in `secrets[]`, and that lives in oxy-infra,
 * which this repository cannot see. This test asserts the half that is in this
 * repo; the other half is a deploy-time observation.
 */

/** The repo root: `packages/backend/src/db/__tests__` is five deep. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const WORKFLOW = readFileSync(join(REPO_ROOT, ".github", "workflows", "deploy-aws.yml"), "utf8");
const CONFIG = readFileSync(
  join(REPO_ROOT, "packages", "backend", "src", "config.ts"),
  "utf8",
);

/**
 * Deliberately NOT synced, each with the reason it is not a secret.
 *
 * A name reaching this list is a decision someone took; a name reaching neither
 * this list nor the workflow is the bug.
 */
const NOT_SYNCED: Readonly<Record<string, string>> = {
  // Public chain infrastructure. `@fairco.in/core` supplies the default and an
  // override is an operational choice, not a credential.
  EXPLORER_BASE_URL: "a public Explorer URL, defaulted from @fairco.in/core",
  // Plain configuration, and both have safe defaults in `config.ts`.
  PEABLE_NETWORK: "mainnet|testnet, a deployment shape rather than a credential",
  PEABLE_SOCIAL_PAY_NETWORK:
    "which network pay-by-@username is enabled on; a deployment decision, and " +
    "it defaults to testnet, so a deployment that never sets it stays closed",
  PEABLE_ALLOWED_ORIGINS: "a CORS allow-list; public by definition",
  PEABLE_CHECKOUT_BASE_URL: "the public checkout origin",
  OXY_API_URL: "the public Oxy API origin",
  PORT: "the listen port, set by the task definition",
};

/**
 * Source with comments removed.
 *
 * Not fussiness: `config.ts`'s own docblock contains the sentence "no
 * `process.env.X!`", and scanning the raw file reports a variable named `X` that
 * nothing reads. A gate whose first run fails on its own prose is a gate people
 * learn to widen rather than trust.
 *
 * Block comments go wholesale; for line comments only WHOLE-LINE ones are
 * dropped (`//` or a leading `*`), because a trailing `//` rule would cut a line
 * at the first `https://` and take real code with it.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .join("\n");
}

/** Every `env.NAME` the config reads. */
function configVariables(): string[] {
  const found = new Set<string>();
  for (const match of withoutComments(CONFIG).matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return [...found].sort();
}

/** Every name the workflow actually writes to SSM. */
function syncedVariables(): string[] {
  const found = new Set<string>();
  for (const match of WORKFLOW.matchAll(/^\s*sync_secret\s+([A-Z][A-Z0-9_]*)\s/gm)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return [...found].sort();
}

describe("the deploy syncs what the config reads", () => {
  it("leaves no variable both unsynced and undeclared", () => {
    const synced = new Set(syncedVariables());
    const orphans = configVariables().filter(
      (name) => !synced.has(name) && !(name in NOT_SYNCED),
    );

    // Named in the message, not just counted: the whole value of this gate is
    // that the failure tells you which variable and therefore which decision is
    // missing.
    expect(orphans).toEqual([]);
  });

  it("syncs every Stripe secret the card rail cannot work without", () => {
    const synced = new Set(syncedVariables());

    // Spelled out rather than left to the sweep above, because these six are the
    // ones that were actually missing and the sweep would also pass if somebody
    // "fixed" it by adding them to NOT_SYNCED.
    for (const name of [
      "STRIPE_ENABLED",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_CONNECT_WEBHOOK_SECRET",
      "STRIPE_WEBHOOK_SECRET_PREVIOUS",
      "STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS",
    ]) {
      expect([name, synced.has(name)]).toEqual([name, true]);
    }
  });

  it("still syncs the three the service already could not boot without", () => {
    const synced = new Set(syncedVariables());
    // A regression floor. `DATABASE_URL` in particular is what `config.ts`
    // refuses to load without, so losing it from the sync is a crash-loop.
    expect(synced.has("DATABASE_URL")).toBe(true);
    expect(synced.has("OXY_ACCESS_TOKEN_SECRET")).toBe(true);
    expect(synced.has("IP_HASH_SALT")).toBe(true);
  });

  it("is not vacuously satisfied by parsers that match nothing", () => {
    // Both halves are regexes over YAML and TypeScript that nothing else
    // exercises. If either stopped matching, every assertion above would pass
    // over two empty sets and this gate would silently stop guarding anything.
    expect(configVariables().length).toBeGreaterThanOrEqual(10);
    expect(syncedVariables().length).toBeGreaterThanOrEqual(10);
  });

  it("declares a reason for every variable it exempts", () => {
    // An empty string would satisfy "is in NOT_SYNCED" while recording no
    // decision at all, which is the shape of the omission this file exists for.
    for (const [name, reason] of Object.entries(NOT_SYNCED)) {
      expect([name, reason.length > 10]).toEqual([name, true]);
    }
  });

  it("exempts nothing that is not actually read", () => {
    // A stale exemption is a name somebody deleted from the config and left
    // here, which quietly widens the ledger's licence for the next reader.
    const read = new Set(configVariables());
    for (const name of Object.keys(NOT_SYNCED)) {
      expect([name, read.has(name)]).toEqual([name, true]);
    }
  });
});
