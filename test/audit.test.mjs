import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import { auditSitemap, isIsoLastmod } from '../lib/audit.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testDirectory, '..');
const fixtures = resolve(testDirectory, 'fixtures');
const root = resolve(fixtures, 'root.xml');
const old = resolve(fixtures, 'old.xml');
const cli = resolve(projectDirectory, 'bin/sitemap-cohort-auditor.mjs');

test('recursively audits sitemap indexes and reports quality signals', async () => {
  const report = await auditSitemap(root);

  assert.deepEqual(report.summary, {
    documents: 4,
    sitemapReferences: 3,
    urlEntries: 6,
    uniqueUrls: 5,
    duplicateUrls: 1,
    duplicateUrlEntries: 1,
    imageEntries: 4,
    uniqueImages: 3,
    lastmodValues: 8,
    invalidLastmodValues: 3,
    fragmentUrls: 2,
    invalidUrls: 1,
    missingLocs: 0,
  });
  assert.deepEqual(report.hosts, [
    { name: 'edilec.com', count: 2 },
    { name: 'legacy.example.org', count: 1 },
    { name: 'www.edilec.com', count: 1 },
  ]);
  assert.deepEqual(report.schemes, [
    { name: 'http', count: 1 },
    { name: 'https', count: 3 },
  ]);
  assert.equal(report.duplicates[0].url, 'https://edilec.com/shared/?x=1&y=2');
  assert.equal(report.duplicates[0].count, 2);
});

test('compares exact decoded URL cohorts', async () => {
  const report = await auditSitemap(root, { compare: old });

  assert.deepEqual(report.comparison.added, [
    'http://legacy.example.org/path#part',
    'https://www.edilec.com/new/#details',
    'not a url',
  ]);
  assert.deepEqual(report.comparison.removed, ['https://edilec.com/old-only/']);
  assert.equal(report.comparison.addedCount, 3);
  assert.equal(report.comparison.removedCount, 1);
});

test('accepts W3C-style lastmod values and rejects invalid calendar values', () => {
  assert.equal(isIsoLastmod('2024-02-29'), true);
  assert.equal(isIsoLastmod('2026-08-10T12:30:00.123+05:30'), true);
  assert.equal(isIsoLastmod('2026-02-29'), false);
  assert.equal(isIsoLastmod('2026-08-10 12:30:00'), false);
  assert.equal(isIsoLastmod('2026-08-10T12:30:00+14:30'), false);
});

test('CLI JSON output is deterministic and parseable', () => {
  const args = [cli, root, '--compare', old, '--json'];
  const first = execFileSync(process.execPath, args, { encoding: 'utf8' });
  const second = execFileSync(process.execPath, args, { encoding: 'utf8' });

  assert.equal(first, second);
  const report = JSON.parse(first);
  assert.equal(report.summary.uniqueUrls, 5);
  assert.equal(report.comparison.removedCount, 1);
});

test('rejects insecure remote sources', () => {
  const result = spawnSync(process.execPath, [cli, 'http://example.com/sitemap.xml'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported source protocol "http:"/);
});
