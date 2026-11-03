// Packaging check for the shipped tree (`postbuild`, so CI's build and the
// release's one build both run it): the `bin` entry exists, starts with a
// shebang, and actually runs under Node from `dist/` — printing this
// package's version — and every `files` entry the manifest lists is present.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function fail(message) {
  console.error(`verify-package: ${message}`);
  process.exit(1);
}

const bin = manifest.bin?.peable;
if (typeof bin !== 'string') fail('package.json has no `bin.peable`');
const binPath = join(root, bin);
if (!existsSync(binPath)) fail(`${bin} was not built`);
if (!readFileSync(binPath, 'utf8').startsWith('#!/usr/bin/env node\n')) {
  fail(`${bin} does not start with a node shebang`);
}
for (const entry of manifest.files ?? []) {
  if (!existsSync(join(root, entry))) fail(`files lists ${entry}, which does not exist`);
}
if (existsSync(join(root, 'dist', 'tsconfig.tsbuildinfo'))) fail('dist carries a .tsbuildinfo');

const printed = execFileSync(process.execPath, [binPath, '--version'], { encoding: 'utf8' }).trim();
if (printed !== manifest.version) {
  fail(`${bin} --version printed '${printed}', package.json says ${manifest.version}`);
}
console.log(`Verified ${manifest.name}@${manifest.version}: ${bin} runs under Node.`);
