// Registry-only consumer check after a coordinated release. No local overrides.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [parentInput] = process.argv.slice(2);
if (!parentInput) throw new Error('usage: node verify-billing-published.mjs <fixture-parent>');
const parent = resolve(parentInput);
mkdirSync(parent, { recursive: true });
const fixture = mkdtempSync(resolve(parent, 'i08-registry-'));
writeFileSync(resolve(fixture, 'package.json'), JSON.stringify({ private: true, dependencies: { '@peable.to/sdk': '0.2.0' } }, null, 2));
execFileSync('bun', ['install', '--minimum-release-age=0', '--no-cache'], { cwd: fixture, stdio: 'pipe' });
const body = `
assert.equal(shared.BILLING_SUBSCRIPTION_STATUSES.includes('active'), true);
assert.equal(sharedManifest.version, '0.3.0');
assert.equal(sdkManifest.version, '0.2.0');
assert.equal(sdkManifest.dependencies['@peable.to/shared-types'], '^0.3.0');
const peable = new sdk.Peable({ publicKey: 'synthetic-public', secret: 'synthetic-secret', baseURL: 'http://127.0.0.1:1', oxyApiUrl: 'http://127.0.0.1:1' });
for (const method of ['ensureCustomer', 'createCheckoutSession', 'createPortalSession', 'retrieveSubscription', 'cancelAtPeriodEnd']) assert.equal(typeof peable.billing[method], 'function');
`;
writeFileSync(resolve(fixture, 'check.cjs'), `const assert = require('node:assert/strict'); const sdk = require('@peable.to/sdk'); const shared = require('@peable.to/shared-types'); const sdkManifest = require('@peable.to/sdk/package.json'); const sharedManifest = require('@peable.to/shared-types/package.json'); ${body}`);
writeFileSync(resolve(fixture, 'check.mjs'), `import assert from 'node:assert/strict'; import * as sdk from '@peable.to/sdk'; import * as shared from '@peable.to/shared-types'; import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); const sdkManifest=require('@peable.to/sdk/package.json'); const sharedManifest=require('@peable.to/shared-types/package.json'); ${body}`);
for (const file of ['check.cjs', 'check.mjs']) execFileSync('node', [file], { cwd: fixture, stdio: 'pipe' });
writeFileSync(resolve(fixture, 'check.ts'), `import { Peable, type BillingSubscription, type BillingRequestOptions } from '@peable.to/sdk';
import type { CreateBillingCheckoutParams, WebhookEvent } from '@peable.to/shared-types';
declare const client: Peable; declare const checkout: CreateBillingCheckoutParams; declare const options: BillingRequestOptions;
const subscription: Promise<BillingSubscription> = client.billing.retrieveSubscription('sub_fixture');
client.billing.createCheckoutSession(checkout, options);
function event(e: WebhookEvent<'payment_intent.settled'>) { return e.data.object.id; }
void subscription; void event;
`);
execFileSync('node', [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'check.ts'], { cwd: fixture, stdio: 'pipe' });
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const proof = { fixture, node: process.version, manifests: ['sdk', 'shared-types'].map(name => { const path = resolve(fixture, 'node_modules/@peable.to', name, 'package.json'); return { name, sha256: hash(path), version: JSON.parse(readFileSync(path)).version }; }), checks: ['Node CJS load and five billing methods', 'Node ESM load and five billing methods', 'TypeScript strict NodeNext with skipLibCheck public consumer', 'SDK minimum shared-types dependency ^0.3.0'], published: true, resolution: 'npm registry SDK0.2.0 only; transitive shared-types0.3.0, no tarball/file/workspace overrides', network: 'Registry installation only; no Oxy/Peable/Stripe requests' };
writeFileSync(resolve(fixture, 'evidence.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof, null, 2));
