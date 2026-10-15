import { contributionOpenApi } from '../packages/contracts/src/openapi';
import { readFileSync, writeFileSync } from 'node:fs';
const path = new URL('../docs/contributions.openapi.json', import.meta.url);
const expected = JSON.stringify(contributionOpenApi(), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== expected)
    throw new Error('Contribution OpenAPI is stale. Run bun scripts/contribution-openapi.ts');
} else writeFileSync(path, expected);
