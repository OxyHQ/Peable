// Local unpublished artifact check. Run after build+pack for both packages.
// Installs only tarballs plus their declared dependencies in a separate directory.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [sharedInput, sdkInput, parentInput] = process.argv.slice(2);
if (!sharedInput || !sdkInput || !parentInput) throw new Error('usage: node verify-billing-packed.mjs <shared.tgz> <sdk.tgz> <fixture-parent>');
const shared = resolve(sharedInput), sdk = resolve(sdkInput), parent = resolve(parentInput);
mkdirSync(parent, { recursive: true });
const fixture = mkdtempSync(resolve(parent, 'i08-packed-'));
writeFileSync(resolve(fixture, 'package.json'), JSON.stringify({ private: true, overrides: { '@peable.to/shared-types': `file:${shared}` }, dependencies: { '@peable.to/shared-types': `file:${shared}`, '@peable.to/sdk': `file:${sdk}` } }, null, 2));
execFileSync('bun', ['install', '--minimum-release-age=0'], { cwd: fixture, stdio: 'pipe' });
const expectedSdkVersion=JSON.parse(readFileSync(resolve(root,'packages/sdk/package.json'),'utf8')).version;
const body = `
assert.equal(shared.BILLING_SUBSCRIPTION_STATUSES.includes('active'), true);
assert.equal(sharedManifest.version, '0.3.0');
assert.equal(sdkManifest.version, ${JSON.stringify(expectedSdkVersion)});
assert.equal(sdkManifest.dependencies['@peable.to/shared-types'], '^0.3.0');
const peable = new sdk.Peable({ publicKey: 'synthetic-public', secret: 'synthetic-secret', baseURL: 'http://127.0.0.1:1', oxyApiUrl: 'http://127.0.0.1:1' });
for (const method of ['ensureCustomer', 'createCheckoutSession', 'createPortalSession', 'retrieveSubscription', 'cancelAtPeriodEnd', 'retrieveCheckout', 'retrievePaidInvoice']) assert.equal(typeof peable.billing[method], 'function');
`;
writeFileSync(resolve(fixture, 'check.cjs'), `const assert = require('node:assert/strict'); const sdk = require('@peable.to/sdk'); const shared = require('@peable.to/shared-types'); const sdkManifest = require('@peable.to/sdk/package.json'); const sharedManifest = require('@peable.to/shared-types/package.json'); ${body}`);
writeFileSync(resolve(fixture, 'check.mjs'), `import assert from 'node:assert/strict'; import * as sdk from '@peable.to/sdk'; import * as shared from '@peable.to/shared-types'; import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); const sdkManifest=require('@peable.to/sdk/package.json'); const sharedManifest=require('@peable.to/shared-types/package.json'); ${body}`);
for (const file of ['check.cjs', 'check.mjs']) execFileSync('node', [file], { cwd: fixture, stdio: 'pipe' });
writeFileSync(resolve(fixture, 'check.ts'), `import { Peable, type BillingCheckoutSession,type BillingCheckoutObservation,type BillingPaidInvoice,type BillingSubscription, type BillingRequestOptions } from '@peable.to/sdk';
import type { CreateBillingCheckoutParams, WebhookEvent } from '@peable.to/shared-types';
declare const client: Peable; declare const checkout: CreateBillingCheckoutParams; declare const options: BillingRequestOptions;
const subscription: Promise<BillingSubscription> = client.billing.retrieveSubscription('sub_fixture');
const hosted:Promise<BillingCheckoutSession>=client.billing.createCheckoutSession(checkout, options);
const observed:Promise<BillingCheckoutObservation>=client.billing.retrieveCheckout('cs_test_fixture');
const paid:Promise<BillingPaidInvoice>=client.billing.retrievePaidInvoice('sub_fixture','in_fixture');
void hosted;void observed;void paid;
function event(e: WebhookEvent<'payment_intent.settled'>) { return e.data.object.id; }
void subscription; void event;
`);
execFileSync('node', [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'check.ts'], { cwd: fixture, stdio: 'pipe' });
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const proof = { fixture, node: process.version, packages: [shared, sdk].map(path => ({ path, sha256: hash(path) })), checks: ['Node CJS load and seven billing methods', 'Node ESM load and seven billing methods', 'TypeScript strict NodeNext public declarations', 'SDK minimum shared-types dependency ^0.3.0'], published: false, resolution: 'Fixture-only shared-types tarball override because these additions are unpublished; packed SDK range independently asserted', network: 'Registry dependency installation only; no Oxy/Peable/Stripe requests' };
writeFileSync(resolve(fixture, 'evidence.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof, null, 2));
