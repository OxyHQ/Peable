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
 * Both stages are checked, not just the builder. The runtime stage runs its own
 * `--frozen-lockfile --production` install and fails the same way.
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

    it(`copies packages/${name}/package.json into the runtime stage`, () => {
      expect(stage('runtime')).toContain(
        `COPY --from=builder /app/packages/${name}/package.json packages/${name}/`,
      );
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
