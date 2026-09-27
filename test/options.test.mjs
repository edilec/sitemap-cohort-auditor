import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { auditSitemap } from '../lib/audit.mjs';

const root = resolve('examples/release');
const current = resolve(root, 'before.xml');
const missing = resolve(root, 'DOES_NOT_EXIST.xml');

test('an unknown library option is rejected before a sitemap is read', async () => {
  const clean = await auditSitemap(current);
  assert.equal(clean.status, 'pass');
  assert.equal(clean.summary.checked, 1);
  await assert.rejects(auditSitemap(current, { timoutMs: 0 }), /unsupported audit option/i);
  await assert.rejects(auditSitemap(missing, { timoutMs: 0 }), /unsupported audit option/i);
});

test('cohort export requires an explicit boolean opt-in', async () => {
  const hidden = await auditSitemap(current, { withCohort: false });
  assert.equal(hidden.status, 'pass');
  assert.equal(hidden.cohort.urls, undefined);
  const optedIn = await auditSitemap(current, { withCohort: true });
  assert.equal(optedIn.status, 'pass');
  assert.equal(optedIn.cohort.urls.length, 4);
  for (const value of ['false', 0, null, undefined]) {
    await assert.rejects(auditSitemap(current, { withCohort: value }), /withCohort.*boolean/i);
  }
});

test('empty or non-string comparison and root options cannot silently disappear', async () => {
  const good = await auditSitemap(current, { root, compare: current });
  assert.equal(good.status, 'pass');
  assert.equal(good.comparison.addedCount, 0);
  assert.equal(good.comparison.removedCount, 0);
  for (const value of ['', null, 0, undefined]) {
    await assert.rejects(auditSitemap(missing, { compare: value }), /compare.*non-empty/i);
    await assert.rejects(auditSitemap(missing, { root: value }), /root.*non-empty/i);
  }
});

test('library options must be own data fields with exact supported names', async () => {
  const inherited = Object.create({ root });
  await assert.rejects(auditSitemap(missing, inherited), /options.*plain object/i);
  const accessor = Object.defineProperty({}, 'root', {
    enumerable: true,
    get() { throw new Error('SYNTHETIC_OPTION_CANARY'); },
  });
  await assert.rejects(auditSitemap(missing, accessor), /data propert/i);
  await assert.rejects(auditSitemap(missing, { [Symbol('hidden')]: 1 }), /unsupported audit option/i);
  for (const options of [null, [], 'root']) {
    await assert.rejects(auditSitemap(missing, options), /options.*plain object/i);
  }
});
