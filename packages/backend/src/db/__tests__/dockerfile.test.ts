import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The backend image and the workspace cannot drift apart.
 *
 * ## The failure this exists for, exactly as it happened
 *
 * `bun install --frozen-lockfile` reconciles the WHOLE workspace, so every
 * member's `package.json` has to be in the build context — including packages
 * the image neither builds nor imports. `packages/pay` was added and the
 * Dockerfile was not, so the deploy failed at `Build and push (linux/arm64)`
 * with `Workspace dependency "@peable.to/pay" not found`, and every step after
 * it — the migration task, the ECS rollout — was SKIPPED. The checkout and
 * frontend workflows went green in the same push, so the run as a whole read as
 * a successful release of a backend that had never shipped.
 *
 * Nothing catches that in review: the Dockerfile is a file no test reads, the
 * lockfile is unchanged, and the error only appears inside a build that only
 * runs after main has already moved.
 *
 * ## Why the list is DERIVED and not restated
 *
 * A test carrying its own copy of the package list is a third copy to keep in
 * step, and it would have been written the same day as the Dockerfile — with
 * the same omission. The glob below is the workspace itself, so the next
 * package added to `packages/` fails this test until both image stages carry
 * it.
 *
 * Both installing stages are checked, not just the builder. The `deps` stage
 * runs its own `--frozen-lockfile --production` install (filtered to the
 * backend) and fails the same way.
 */

/** The repo root: `packages/backend/src/db/__tests__` is five levels deep. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const DOCKERFILE_PATH = join(REPO_ROOT, 'packages', 'backend', 'Dockerfile');
const DOCKERIGNORE_PATH = join(REPO_ROOT, '.dockerignore');

const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
const dockerignore = readFileSync(DOCKERIGNORE_PATH, 'utf8');

/**
 * Every workspace member, read off the filesystem rather than off a list.
 *
 * The root manifest declares `workspaces: ["packages/*"]`, so a directory with
 * a `package.json` under `packages/` IS a member — there is no second source of
 * truth to consult and no place for this test to disagree with bun.
 */
function workspacePackageDirectories(): string[] {
  const packagesDir = join(REPO_ROOT, 'packages');
  return readdirSync(packagesDir)
    .filter((entry) => {
      const candidate = join(packagesDir, entry);
      if (!statSync(candidate).isDirectory()) return false;
      try {
        return statSync(join(candidate, 'package.json')).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** The Dockerfile text of one `FROM … AS <stage>` block. */
function stage(name: string): string {
  const start = dockerfile.indexOf(`AS ${name}`);
  expect(start).toBeGreaterThan(-1);
  const rest = dockerfile.slice(start);
  const nextFrom = rest.indexOf('\nFROM ');
  return nextFrom === -1 ? rest : rest.slice(0, nextFrom);
}

describe('the backend image carries the whole workspace manifest set', () => {
  const packages = workspacePackageDirectories();

  it('finds the workspace members it is supposed to check', () => {
    // Vacuity floor: were the glob to answer nothing, every assertion below
    // would pass against an empty Dockerfile.
    expect(packages.length).toBeGreaterThanOrEqual(5);
    expect(packages).toContain('backend');
    expect(packages).toContain('pay');
  });

  for (const name of packages) {
    it(`copies packages/${name}/package.json into the builder stage`, () => {
      expect(stage('builder')).toContain(`COPY packages/${name}/package.json packages/${name}/`);
    });

    it(`copies packages/${name}/package.json into the deps stage`, () => {
      expect(stage('deps')).toContain(`COPY packages/${name}/package.json packages/${name}/`);
    });

    it(`does not let .dockerignore hide packages/${name}/package.json`, () => {
      // A package whose source is excluded to keep the context small must
      // re-admit its manifest, or the COPY above fails with "file not found" —
      // which reads like a typo in the Dockerfile rather than an exclusion two
      // files away.
      const excluded = dockerignore.includes(`packages/${name}/*`);
      if (!excluded) return;
      expect(dockerignore).toContain(`!packages/${name}/package.json`);
    });
  }
});

/**
 * The runtime image carries the backend's production closure and nothing else.
 *
 * It used to run `bun install --production` at the workspace root, which ships
 * every workspace's production dependencies (Expo, React Native, Electron) into
 * an image whose only process is the gateway. ci.yml's `image` job proves the
 * result on the built image; this pins the shape that produces it, so a change
 * that widens the install fails here first, with a message naming the flag.
 */
describe('the runtime image installs only the backend production closure', () => {
  const installs = dockerfile.split('\n').filter((line) => /^RUN .*\bbun install\b/.test(line));

  it('finds the installs it is supposed to check', () => {
    expect(installs.length).toBe(2);
  });

  it('never installs without the frozen lockfile', () => {
    for (const line of installs) expect(line).toContain('--frozen-lockfile');
  });

  it('never runs install scripts', () => {
    for (const line of installs) expect(line).toContain('--ignore-scripts');
  });

  it('installs the runtime closure in the deps stage, filtered to the backend', () => {
    const install = stage('deps')
      .split('\n')
      .find((line) => line.startsWith('RUN bun install'));
    expect(install).toBeDefined();
    for (const flag of ['--production', '--omit=peer', '--filter @peable.to/backend']) {
      expect(install).toContain(flag);
    }
  });

  it('runs no install in the runtime stage and takes node_modules from deps', () => {
    const runtime = stage('runtime');
    expect(runtime).not.toContain('bun install');
    expect(runtime).toContain('COPY --from=deps /app/node_modules/ node_modules/');
    expect(runtime).not.toMatch(/COPY --from=builder \/app\/node_modules/);
  });

  it('preserves workspace-local production dependencies when versions cannot be hoisted', () => {
    for (const workspace of ['backend', 'contracts', 'shared-types']) {
      expect(stage('runtime')).toContain(
        `COPY --from=deps /app/packages/${workspace}/node_modules/ packages/${workspace}/node_modules/`,
      );
    }
  });

  it('leaves every runtime file owned by root', () => {
    expect(stage('runtime')).not.toContain('--chown');
  });

  it('runs as the unprivileged app user', () => {
    expect(stage('runtime')).toContain('USER appuser');
  });
});
