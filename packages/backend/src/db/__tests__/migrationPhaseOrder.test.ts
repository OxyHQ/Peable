/**
 * A `post` migration in front of a `pre` one blocks the whole release.
 *
 * ## What this caught, after it had already happened
 *
 * `planMigrationRun` defers everything from the first pending `post` migration
 * onwards, then REFUSES the run if any deferred entry is a `pre` — because
 * applying that later `pre` would mean applying the `post` in front of it
 * first, and the ledger records progress as a high-water mark and cannot skip
 * one. Its own words, from the migrator task that failed in production:
 *
 * > `0012_stormy_valkyrie` is a pre-deploy migration queued behind the
 * > post-deploy migration `0011_magical_cyclops`, which is not applied yet.
 *
 * Every deploy after that file merged failed at `Migrate (pre)` with a green
 * build, so the signal was three steps into a workflow nobody reads when it
 * goes well, on a repository whose tests all passed. This turns the same shape
 * into a red build, which is where it costs a minute instead of a release.
 *
 * ## The rule, and why it is stated over the journal rather than per file
 *
 * A single migration is never wrong on its own — `post` is the CORRECT phase
 * for a constraint that the old image would violate. It becomes wrong only in
 * the company it keeps, and only the ordered journal shows that. So:
 *
 * **A `post` migration must be the last entry in the journal.** Anything added
 * after it either has to be `post` too, or the `post` has to become `pre` and
 * carry the rollout-window risk explicitly (which is what `0011` does, and says
 * so in its own header).
 *
 * `SHIPPED_BEFORE` is the escape, and it is an escape from history rather than
 * from the rule: once a `post` has actually been applied in production it is no
 * longer pending, so it cannot strand anything, and a later `pre` is fine. That
 * is only ever knowable from outside the repository, which is why it is a
 * hand-maintained list with a reason per entry and not a heuristic.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

/**
 * `post` migrations already applied in production, so no longer pending and
 * unable to strand anything queued behind them.
 *
 * Adding to this list is a claim about the production ledger, not about the
 * repository. Verify it — the migrator names the first stranded pair when it
 * refuses — before writing a tag here.
 */
const SHIPPED_BEFORE: Record<string, string> = {
  // Applied well before `0010` was authored; the migrator confirmed it by
  // naming `0011`/`0012` as the stranded pair and not this one.
  "0009_fuzzy_misty_knight": "applied in production before 0010 existed",
};

interface Migration {
  readonly tag: string;
  readonly phase: string;
}

/** Every migration in journal order, with the phase its marker declares. */
function readMigrations(): Migration[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };

  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
      const markers = [...sql.matchAll(/^--\s*oxy:deploy-phase=(\S+)\s*$/gm)].map(
        (match) => match[1] ?? "",
      );
      expect(markers, `${entry.tag} must declare exactly one deploy phase`).toHaveLength(1);
      return { tag: entry.tag, phase: markers[0] ?? "" };
    });
}

describe("migration deploy phases", () => {
  /**
   * There is no default: `bun run db:generate` writes the SQL and a human
   * chooses the phase, so a file with no marker is one nobody decided about.
   */
  test("every migration declares a phase, and it is pre or post", () => {
    const migrations = readMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    for (const { tag, phase } of migrations) {
      expect(["pre", "post"], `${tag} declares an unknown phase '${phase}'`).toContain(phase);
    }
  });

  /**
   * THE gate. A `pre` after an unshipped `post` is a release that does not
   * deploy at all — the build goes green, the image is pushed, and the
   * migrator refuses before ECS is ever touched.
   */
  test("no pre migration is queued behind a post one", () => {
    const migrations = readMigrations();
    const blockers = migrations.filter(
      (migration) => migration.phase === "post" && !(migration.tag in SHIPPED_BEFORE),
    );

    const stranded = migrations.flatMap((migration, index) => {
      if (migration.phase !== "pre") return [];
      const blocker = blockers.find((candidate) => migrations.indexOf(candidate) < index);
      return blocker ? [`${migration.tag} is queued behind ${blocker.tag}`] : [];
    });

    expect(stranded).toEqual([]);
  });

  /**
   * The same rule said forwards, so the failure message names what to do
   * rather than what went wrong: if the new migration has to be `post`, it has
   * to be last, and anything that must run before the rollout has to land in
   * an earlier release.
   */
  test("a post migration is the last entry in the journal", () => {
    const migrations = readMigrations();
    const unshipped = migrations.filter(
      (migration) => migration.phase === "post" && !(migration.tag in SHIPPED_BEFORE),
    );
    const last = migrations.at(-1)?.tag ?? "";

    for (const migration of unshipped) {
      expect(migration.tag, "a post migration must be the last one in the journal").toBe(last);
    }
  });
});
