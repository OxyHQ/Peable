import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_RUNS, POST_PHASE_GREP_PATTERN } from '@oxy.so/db/migrate';
import { MIGRATIONS_FOLDER } from '../migrate';

/**
 * The deploy workflow and the migrator cannot drift apart.
 *
 * ## Why a test, when the workflow is not code this package runs
 *
 * `deploy-aws.yml` and `run-migration-task.sh` between them carry four copies of
 * facts this package owns — the phase-marker syntax, the set of legal phases,
 * the path to the migrations folder, and the path to the migrator entrypoint.
 * Every one of them is in a file no test would otherwise read, and each fails
 * silently in its own way:
 *
 *  - a stale grep pattern reads as "no post migration in this release", so the
 *    drop is never applied by anything and the deploy goes green;
 *  - a wrong migrations path greps a directory that does not exist, which reads
 *    identically;
 *  - a wrong entrypoint path fails the task with `MODULE_NOT_FOUND`, which reads
 *    like a broken migration rather than a typo in YAML;
 *  - a phase value outside `MIGRATION_RUNS` is refused by the migrator at deploy
 *    time, which is the right behaviour and a terrible moment to discover it.
 *
 * `POST_PHASE_GREP_PATTERN` is exported by `@oxy.so/db` for exactly this: its own
 * docblock says a CI gate can assert the workflow carries the string.
 */

/** The repo root, from this file: `packages/backend/src/db/__tests__` is five deep. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'deploy-aws.yml');
const SCRIPT_PATH = join(REPO_ROOT, '.github', 'scripts', 'run-migration-task.sh');

const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');
const script = readFileSync(SCRIPT_PATH, 'utf8');

/** Only the shape these assertions read — not a schema for GitHub Actions. */
interface WorkflowFile {
  readonly on: {
    readonly workflow_dispatch?: {
      readonly inputs?: Record<string, { readonly default?: string; readonly options?: string[] }>;
    };
  };
  readonly jobs: Record<
    string,
    { readonly steps: { readonly name?: string; readonly if?: string; readonly run?: string }[] }
  >;
}

const workflow = Bun.YAML.parse(workflowSource) as WorkflowFile;
const steps = workflow.jobs.deploy?.steps ?? [];

describe('the deploy workflow and the migrator agree', () => {
  it('greps migrations with the pattern @oxy.so/db exports, not a copy of it', () => {
    // Vacuity floor: were the constant ever exported as an empty string, the
    // assertion below would pass against any workflow at all.
    expect(POST_PHASE_GREP_PATTERN.length).toBeGreaterThan(10);
    expect(workflowSource).toContain(POST_PHASE_GREP_PATTERN);
  });

  /**
   * The pattern check alone would pass on a workflow that carried the string in
   * a comment and grepped for something else, so the step that actually runs is
   * checked too — and checked against the REAL migrations directory, which is
   * the copy most likely to rot: this repository keeps its migrations under
   * `src/` (the runtime image runs TypeScript source under Bun and copies only
   * `src/`), which is not where drizzle-kit's default would put them.
   */
  it('greps the directory the migrator actually reads', () => {
    const relativeFolder = relative(REPO_ROOT, MIGRATIONS_FOLDER);
    expect(existsSync(MIGRATIONS_FOLDER)).toBe(true);

    const detect = steps.find((step) => step.name?.includes('Detect a post-rollout migration'));
    expect(detect?.run).toBeDefined();
    expect(detect?.run).toContain(relativeFolder);
    expect(detect?.run).toContain(POST_PHASE_GREP_PATTERN);
  });

  /**
   * The migration task runs `bun` on TypeScript SOURCE, because this image has
   * no compiled JavaScript at all — the Dockerfile's runtime stage copies
   * `packages/backend/src/` and runs `bun packages/backend/src/server.ts`, with
   * `bun run build` used only as a discarded type gate. The sibling repositories
   * this script was adapted from run `node <pkg>/dist/db/migrate.js`, so this is
   * exactly the line a copy-paste would get wrong, and the failure would be a
   * `MODULE_NOT_FOUND` at deploy time rather than anything nearer the mistake.
   */
  it('invokes an entrypoint that exists, with bun and not node', () => {
    const entrypoint = 'packages/backend/src/db/migrate.ts';
    expect(existsSync(join(REPO_ROOT, entrypoint))).toBe(true);
    expect(script).toContain(`"bun", "${entrypoint}"`);

    // The NEGATIVE check reads comment-stripped source, because the script
    // documents the trap in the same words the trap is spelled in — a scan of
    // the raw file matches its own warning and fails on a correct script.
    // (Measured: it did, the first time this ran.)
    const executable = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(executable).toContain(entrypoint);
    expect(executable).not.toContain('dist/db/migrate.js');
    expect(executable).not.toContain('"node"');
  });

  it('passes only phases the migrator accepts', () => {
    expect(MIGRATION_RUNS.length).toBeGreaterThan(0);

    const invoked = [...script.matchAll(/run-migration-task\.sh <?([a-z|]+)>?/g)]
      .flatMap((match) => (match[1] ?? '').split('|'))
      .filter((phase) => phase !== '' && phase !== 'pre|post|all');
    const fromWorkflow = steps
      .map((step) => step.run ?? '')
      .flatMap((run) => [...run.matchAll(/run-migration-task\.sh\s+([a-z]+)/g)])
      .map((match) => match[1] ?? '');

    // Vacuity floor: three call sites — all, pre, post.
    expect(fromWorkflow.length).toBe(3);
    for (const phase of [...invoked, ...fromWorkflow]) {
      expect([phase, MIGRATION_RUNS.includes(phase as (typeof MIGRATION_RUNS)[number])]).toEqual([
        phase,
        true,
      ]);
    }
  });

  /**
   * `all` applies the whole chain in journal order, including anything
   * destructive, while the previous image is still serving. It is the from-zero
   * genesis path and nothing else, so it must be reachable ONLY by a person
   * choosing it from `workflow_dispatch` — never from a `push`.
   */
  it('keeps the cutover path off the push trigger', () => {
    const options = workflow.on.workflow_dispatch?.inputs?.migration_phase?.options ?? [];
    expect(options).toContain('all');
    expect(workflow.on.workflow_dispatch?.inputs?.migration_phase?.default).toBe('pre-post');

    const cutover = steps.find((step) => step.name?.includes('Migrate (all)'));
    expect(cutover?.if).toContain("steps.ecs.outputs.phase_mode == 'all'");
    // `phase_mode` falls back to `pre-post` when the input is absent, which is
    // every push. Without that default an unset input would be the empty string
    // and the pre/post pair would be the branch taken — right by accident.
    const resolve = steps.find((step) => step.name?.includes('Resolve the ECS one-shot shape'));
    expect(resolve?.run).toContain('${REQUESTED_PHASE:-pre-post}');
  });

  /**
   * No migration step may be gated on a `DATABASE_URL` preflight.
   *
   * There WAS one, and retiring it was the point of the route switch rather
   * than an oversight. It existed while no route read Postgres: a task
   * definition without the variable served fine, so skipping migrations was
   * harmless. Now `config.ts` refuses to load without `DATABASE_URL` and
   * `server.ts` opens the pool before listening, so a task definition missing
   * it crash-loops — and a probe that answered that by SKIPPING the migrations
   * and letting the rollout continue would turn a loud configuration error
   * into a silent one plus an unmigrated database.
   *
   * This asserts the absence because the failure it guards against is somebody
   * reinstating the skip. Gated on `status == 'ACTIVE'` still, which is a
   * different question: whether there is a service to migrate against at all.
   */
  it('runs every migration step with no DATABASE_URL preflight to skip it', () => {
    const migrationSteps = steps.filter((step) => step.name?.startsWith('Migrate ('));
    expect(migrationSteps.length).toBe(3);
    for (const step of migrationSteps) {
      expect([step.name, step.if?.includes('has_database_url')]).toEqual([step.name, false]);
      expect([step.name, step.if?.includes("steps.ecs.outputs.status == 'ACTIVE'")]).toEqual([
        step.name,
        true,
      ]);
    }
    // Nowhere else in the workflow either — the output itself is gone, not
    // merely unread by these three steps.
    expect(workflowSource).not.toContain('has_database_url');
  });

  /** `post` runs after the rollout; `pre` and the cutover run before it. */
  it('orders the phases around the rollout', () => {
    const names = steps.map((step) => step.name ?? '');
    const rollout = names.findIndex((name) => name.startsWith('Deploy to ECS'));
    expect(rollout).toBeGreaterThan(-1);
    expect(names.findIndex((name) => name.startsWith('Migrate (all)'))).toBeLessThan(rollout);
    expect(names.findIndex((name) => name.startsWith('Migrate (pre)'))).toBeLessThan(rollout);
    expect(names.findIndex((name) => name.startsWith('Migrate (post)'))).toBeGreaterThan(rollout);
  });
});
