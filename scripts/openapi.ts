// Writes `docs/openapi.json` — the OpenAPI 3.1 document of the whole public
// API, generated from `packages/contracts` (ADR 0014 D5). With `--check` it
// writes nothing and fails when the committed copy differs, which is the CI
// drift gate (`bun run check:openapi`).
import { readFileSync, writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../packages/contracts/src/openapi';

const target = new URL('../docs/openapi.json', import.meta.url);
// Plain two-space JSON: the document is a generated artefact (excluded from
// Biome, which caps files at 1 MiB), and this gate is its only check.
const expected = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(target, 'utf8');
  } catch {
    // Missing is stale.
  }
  if (committed !== expected) {
    console.error(
      'docs/openapi.json is stale: the contracts changed. Run `bun run generate:openapi` and commit the result.',
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, expected);
}
