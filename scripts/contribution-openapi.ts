import { contributionOpenApi } from '../packages/contracts/src/openapi';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const path = new URL('../docs/contributions.openapi.json', import.meta.url);
const expected = execFileSync(
  'bun',
  ['x', 'biome', 'format', '--stdin-file-path=docs/contributions.openapi.json'],
  { input: JSON.stringify(contributionOpenApi(), null, 2), encoding: 'utf8' },
);
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== expected)
    throw new Error('Contribution OpenAPI is stale. Run bun scripts/contribution-openapi.ts');
} else writeFileSync(path, expected);
