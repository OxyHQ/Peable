// Writes Peable's generated docs pages into the SDK's docs tree
// (`packages/sdk/docs/`, published on oxy.so/developers/docs/peable/ by the
// website's sync-docs): the API reference from `docs/openapi.json` and the
// error-code page from the contracts' error vocabulary. With `--check` it writes
// nothing and fails when the committed pages differ from what the sources
// produce — the CI drift gate (`bun run check:api-docs`). Both modes also fail
// on a dead link between docs pages, and on an error code whose anchor is not
// the code itself, since every error envelope's `doc_url` names one.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ERROR_CODES, ERROR_DOCS_BASE_URL } from '../packages/contracts/src/vocabulary/errors';
import { errorsPage } from './api-docs/errors';
import { deadLinks, slugOf } from './api-docs/links';
import { type OpenApiDocument, REFERENCE_DIR, referencePages } from './api-docs/openapi';

const ROOT = new URL('..', import.meta.url).pathname;
const SDK = join(ROOT, 'packages/sdk');
const config = JSON.parse(readFileSync(join(SDK, 'docs.config.json'), 'utf8')) as {
  shortName: string;
  docsPath: string;
};
const DOCS = join(SDK, config.docsPath);
const document = JSON.parse(
  readFileSync(join(ROOT, 'docs/openapi.json'), 'utf8'),
) as OpenApiDocument;

const failures: string[] = [];

// The pages this run owns: everything under reference/, plus the two roots.
const errors = errorsPage();
const generated = new Map<string, string>([[errors.file, errors.content]]);
for (const page of referencePages(document)) generated.set(page.file, page.content);

for (const code of ERROR_CODES) {
  if (errors.codeAnchors.get(code) !== code)
    failures.push(`error code '${code}' renders at #${errors.codeAnchors.get(code)}, not #${code}`);
}
const expectedBase = `https://oxy.so/developers/docs/${config.shortName}/${slugOf(errors.file)}/`;
if (ERROR_DOCS_BASE_URL !== expectedBase)
  failures.push(`ERROR_DOCS_BASE_URL is ${ERROR_DOCS_BASE_URL}, but the page is ${expectedBase}`);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : /\.mdx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

const owned = (file: string) => file.startsWith(`${REFERENCE_DIR}/`) || generated.has(file);
const onDisk = new Map(
  walk(DOCS).map((path) => [relative(DOCS, path).replace(/\\/g, '/'), readFileSync(path, 'utf8')]),
);

if (process.argv.includes('--check')) {
  for (const [file, content] of generated) {
    if (onDisk.get(file) !== content) failures.push(`${file} is stale`);
  }
  for (const file of onDisk.keys()) {
    if (owned(file) && !generated.has(file)) failures.push(`${file} is no longer generated`);
  }
} else {
  rmSync(join(DOCS, REFERENCE_DIR), { recursive: true, force: true });
  for (const [file, content] of generated) {
    mkdirSync(dirname(join(DOCS, file)), { recursive: true });
    writeFileSync(join(DOCS, file), content);
  }
}

// Links are judged on what the site will publish: the hand-written pages as
// they are, the generated ones as this run produces them.
const published = new Map([...onDisk].filter(([file]) => !owned(file)));
for (const [file, content] of generated) published.set(file, content);
failures.push(...deadLinks(published).map((link) => `dead link — ${link}`));

if (failures.length > 0) {
  console.error(
    `packages/sdk/docs: ${failures.length} problem(s). Run \`bun run generate:api-docs\` and commit the result, or fix the link.`,
  );
  for (const failure of failures.slice(0, 50)) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `packages/sdk/docs: ${generated.size} generated page(s) ${process.argv.includes('--check') ? 'are current' : 'written'}; ${published.size} page(s), no dead link.`,
);
