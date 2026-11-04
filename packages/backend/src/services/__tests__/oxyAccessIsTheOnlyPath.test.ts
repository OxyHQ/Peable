/**
 * There is ONE way the gateway asks Oxy what a signed-in person may do
 * (`services/oxyAccess.ts`), and ONE end-user auth middleware (`lib/http.ts`).
 *
 * A second path is easy to add and silent once added — it answers, with its
 * own idea of who may do what (two of them once disagreed: one read role
 * names, the other any membership). This reads every source file and fails on
 * an access read or the auth middleware anywhere else, on any rebuilt piece of
 * what `@oxy.so/core` owns (a raw membership read, a per-user client), and on a
 * permission string spelled out in the gateway instead of read from
 * `DASHBOARD_PERMISSIONS`.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** The code, without its comments: a doc may NAME a call without making it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const FILES = sources(SRC).map((path) => ({ file: relative(SRC, path), text: code(path) }));

const ONLY_IN: readonly (readonly [string, RegExp, string])[] = [
  ['an application access read', /\.applicationAccessFor\(/, 'services/oxyAccess.ts'],
  ['an account access read', /\.accountAccessFor\(/, 'services/oxyAccess.ts'],
  ['the end-user auth middleware', /createOxyAuthMiddleware\(/, 'lib/http.ts'],
];

test.each(ONLY_IN)('%s lives only in %s', (_what, pattern, home) => {
  const where = FILES.filter(({ text }) => pattern.test(text)).map(({ file }) => file);
  // Vacuity floor: the one place really does it.
  expect(where).toEqual([home]);
});

/**
 * What `@oxy.so/core` owns and the gateway must not rebuild: the raw reads
 * behind `applicationAccessFor` / `accountAccessFor`, a client bound to a
 * person's bearer, and the SDK's own access middleware (it answers in the
 * SDK's envelope, not Peable's).
 */
const NOWHERE: readonly (readonly [string, RegExp])[] = [
  ['a raw application read', /\.apps\.get\(/],
  ['a raw account read', /\.accounts\.get\(/],
  ['a callerMembership read', /callerMembership/],
  ['a per-caller Oxy client', /new OxyServices\(|\.withUser\(|\.asUser\(/],
  ['the SDK access middleware', /requireApplicationAccess|requireAccountAccess/],
];

test.each(NOWHERE)('no %s in the gateway', (_what, pattern) => {
  expect(FILES.filter(({ text }) => pattern.test(text)).map(({ file }) => file)).toEqual([]);
});

test('no Oxy permission is spelled out in the gateway: they come from DASHBOARD_PERMISSIONS', () => {
  const spelled = FILES.filter(({ text }) =>
    /['"](app|apps|webhooks|billing|credentials|members):[a-z_:]+['"]/.test(text),
  ).map(({ file }) => file);
  expect(spelled).toEqual([]);
});

test('nothing asks for the application’s OWN roles in place of membership', () => {
  const where = FILES.filter(({ text }) => /appPermissionsFor|requireAppPermission/.test(text));
  expect(where.map(({ file }) => file)).toEqual([]);
});
