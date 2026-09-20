import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditSitemap, cohortDigest, formatTextReport } from '../lib/audit.mjs';
import { evaluatePolicy } from '../lib/policy.mjs';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/sitemap-cohort-auditor.mjs');

function urlset(urls) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${url}</loc></url>`).join('\n')}
</urlset>`;
}

const BEFORE = ['https://example.com/a', 'https://example.com/b', 'https://example.com/legacy'];
const AFTER = ['https://example.com/a', 'https://example.com/b', 'https://example.com/new'];

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), 'cohort-baseline-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function write(directory, name, contents) {
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

test('the cohort digest is stable and order-independent', () => {
  const digest = cohortDigest(['https://example.com/a', 'https://example.com/b']);

  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(digest, cohortDigest(['https://example.com/a', 'https://example.com/b']));
  assert.notEqual(digest, cohortDigest(['https://example.com/a']));
});

test('cohort digest frames newline-containing URLs instead of aliasing two entries', async () => {
  assert.notEqual(cohortDigest(['https://example.test/a\nhttps://example.test/b']),
    cohortDigest(['https://example.test/a', 'https://example.test/b']));

  await withTempDir(async (directory) => {
    const one = await write(directory, 'one.xml', urlset([
      'https://example.test/a&#10;https://example.test/b',
    ]));
    const two = await write(directory, 'two.xml', urlset([
      'https://example.test/a',
      'https://example.test/b',
    ]));
    const same = await auditSitemap(two, { compare: two });
    const changed = await auditSitemap(two, { compare: one });
    assert.equal(same.comparison.cohortChanged, false);
    assert.equal(changed.comparison.cohortChanged, true);
    assert.equal(changed.comparison.addedCount, 2);
    assert.equal(changed.comparison.removedCount, 1);
  });
});

test('every report carries a cohort count and digest, and the URL list only on request', async () => {
  await withTempDir(async (directory) => {
    const sitemap = await write(directory, 'sitemap.xml', urlset(BEFORE));

    const lean = await auditSitemap(sitemap);
    assert.equal(lean.cohort.count, 3);
    assert.match(lean.cohort.digest, /^sha256:/);
    assert.equal(lean.cohort.urls, undefined);

    const full = await auditSitemap(sitemap, { withCohort: true });
    assert.deepEqual(full.cohort.urls, [...BEFORE].sort());
    assert.equal(full.cohort.digest, lean.cohort.digest);
  });
});

test('an earlier report with its cohort reports the deliberately removed URL', async () => {
  await withTempDir(async (directory) => {
    const before = await write(directory, 'before.xml', urlset(BEFORE));
    const baseline = await auditSitemap(before, { withCohort: true });
    const baselinePath = await write(directory, 'baseline.json', JSON.stringify(baseline));

    const after = await write(directory, 'after.xml', urlset(AFTER));
    const report = await auditSitemap(after, { compare: baselinePath });

    assert.equal(report.comparison.evidence, 'urls');
    assert.equal(report.comparison.cohortChanged, true);
    assert.deepEqual(report.comparison.removed, ['https://example.com/legacy']);
    assert.deepEqual(report.comparison.added, ['https://example.com/new']);
    assert.equal(report.comparison.previousUniqueUrls, 3);
  });
});

test('comparing a sitemap against a sitemap still works unchanged', async () => {
  await withTempDir(async (directory) => {
    const before = await write(directory, 'before.xml', urlset(BEFORE));
    const after = await write(directory, 'after.xml', urlset(AFTER));

    const report = await auditSitemap(after, { compare: before });

    assert.equal(report.comparison.evidence, 'urls');
    assert.deepEqual(report.comparison.removed, ['https://example.com/legacy']);
  });
});

test('an unchanged cohort reports no change and no movement', async () => {
  await withTempDir(async (directory) => {
    const sitemap = await write(directory, 'sitemap.xml', urlset(BEFORE));
    const baseline = await auditSitemap(sitemap, { withCohort: true });
    const baselinePath = await write(directory, 'baseline.json', JSON.stringify(baseline));

    const report = await auditSitemap(sitemap, { compare: baselinePath });

    assert.equal(report.comparison.cohortChanged, false);
    assert.equal(report.comparison.addedCount, 0);
    assert.equal(report.comparison.removedCount, 0);
  });
});

test('a digest-only baseline reports unknown movement instead of zero', async () => {
  await withTempDir(async (directory) => {
    const before = await write(directory, 'before.xml', urlset(BEFORE));
    const baseline = await auditSitemap(before);
    const baselinePath = await write(directory, 'baseline.json', JSON.stringify(baseline));

    const after = await write(directory, 'after.xml', urlset(AFTER));
    const report = await auditSitemap(after, { compare: baselinePath });

    assert.equal(report.comparison.evidence, 'digest-only');
    assert.equal(report.comparison.cohortChanged, true);
    assert.equal(report.comparison.addedCount, undefined);
    assert.equal(report.comparison.removedCount, undefined);
    assert.equal(report.comparison.added, undefined);
    assert.match(report.comparison.note, /added and removed URLs are unknown/);
  });
});

test('human report renders digest-only movement as unknown without crashing', async () => {
  await withTempDir(async (directory) => {
    const before = await write(directory, 'before.xml', urlset(BEFORE));
    const baseline = await auditSitemap(before);
    const baselinePath = await write(directory, 'baseline.json', JSON.stringify(baseline));
    const after = await write(directory, 'after.xml', urlset(AFTER));
    const report = await auditSitemap(after, { compare: baselinePath });

    assert.equal(report.comparison.evidence, 'digest-only');
    assert.equal(report.comparison.added, undefined);
    assert.match(formatTextReport(report), /Added: unknown/);
    assert.match(formatTextReport(report), /Removed: unknown/);
    assert.doesNotMatch(formatTextReport(report), /Added: 0\b|Removed: 0\b/);
  });
});

test('maxRemovedUrls fails closed when the baseline recorded only a digest', async () => {
  await withTempDir(async (directory) => {
    const before = await write(directory, 'before.xml', urlset(BEFORE));
    const baseline = await auditSitemap(before);
    const baselinePath = await write(directory, 'baseline.json', JSON.stringify(baseline));

    const after = await write(directory, 'after.xml', urlset(AFTER));
    const report = await auditSitemap(after, { compare: baselinePath });

    assert.throws(
      () => evaluatePolicy(report, { schemaVersion: 1, maxRemovedUrls: 0 }),
      /known removed-URL count/,
    );
  });
});

test('maxRemovedUrls still evaluates when the movement is known', async () => {
  await withTempDir(async (directory) => {
    const before = await write(directory, 'before.xml', urlset(BEFORE));
    const baseline = await auditSitemap(before, { withCohort: true });
    const baselinePath = await write(directory, 'baseline.json', JSON.stringify(baseline));

    const after = await write(directory, 'after.xml', urlset(AFTER));
    const report = await auditSitemap(after, { compare: baselinePath });

    const strict = evaluatePolicy(report, { schemaVersion: 1, maxRemovedUrls: 0 });
    assert.ok(strict.findings.some((finding) => finding.code === 'MAX_REMOVED_URLS'));

    const lenient = evaluatePolicy(report, { schemaVersion: 1, maxRemovedUrls: 5 });
    assert.equal(lenient.findings.some((finding) => finding.code === 'MAX_REMOVED_URLS'), false);
  });
});

test('a tampered cohort list is rejected rather than trusted', async () => {
  await withTempDir(async (directory) => {
    const before = await write(directory, 'before.xml', urlset(BEFORE));
    const baseline = await auditSitemap(before, { withCohort: true });
    baseline.cohort.urls = ['https://example.com/injected'];
    const baselinePath = await write(directory, 'baseline.json', JSON.stringify(baseline));

    const after = await write(directory, 'after.xml', urlset(AFTER));
    await assert.rejects(
      auditSitemap(after, { compare: baselinePath }),
      /Comparison report/,
    );
  });
});

test('duplicate JSON keys cannot replace earlier baseline evidence', async () => {
  await withTempDir(async (directory) => {
    const current = await write(directory, 'current.xml', urlset(AFTER));
    const baseline = await auditSitemap(current, { withCohort: true });
    const json = JSON.stringify(baseline).replace(
      '"cohort":{"count":3', '"cohort":{"count":999,"count":3',
    );
    const path = await write(directory, 'ambiguous.json', json);
    await assert.rejects(auditSitemap(current, { compare: path }), /duplicate JSON key/);
  });
});

test('a comparison report cannot claim a count or digest contradicted by its cohort', async () => {
  await withTempDir(async (directory) => {
    const current = await write(directory, 'current.xml', urlset(AFTER));
    const baseline = await auditSitemap(current, { withCohort: true });
    const wrongCount = await write(directory, 'wrong-count.json', JSON.stringify({
      ...baseline,
      cohort: { ...baseline.cohort, count: 999 },
    }));
    const wrongDigest = await write(directory, 'wrong-digest.json', JSON.stringify({
      ...baseline,
      cohort: { ...baseline.cohort, digest: 'not-a-digest' },
    }));
    const duplicate = await write(directory, 'duplicate.json', JSON.stringify({
      ...baseline,
      cohort: { ...baseline.cohort, count: 4, urls: [...baseline.cohort.urls, AFTER[0]] },
    }));
    for (const path of [wrongCount, wrongDigest, duplicate]) {
      await assert.rejects(auditSitemap(current, { compare: path }), /comparison report/i);
    }
  });
});

test('a validated legacy full-list baseline converts to framed comparison evidence', async () => {
  await withTempDir(async (directory) => {
    const current = await write(directory, 'current.xml', urlset(AFTER));
    const legacyDigest = createHash('sha256');
    for (const url of BEFORE) legacyDigest.update(url).update('\n');
    const baselinePath = await write(directory, 'legacy.json', JSON.stringify({
      schemaVersion: 1,
      cohort: {
        count: BEFORE.length,
        digest: `sha256:${legacyDigest.digest('hex')}`,
        urls: BEFORE,
      },
    }));
    const report = await auditSitemap(current, { compare: baselinePath });
    assert.equal(report.comparison.evidence, 'urls');
    assert.equal(report.comparison.cohortChanged, true);
    assert.deepEqual(report.comparison.removed, ['https://example.com/legacy']);
  });
});

test('a legacy digest-only baseline stays incomplete instead of comparing digest versions', async () => {
  await withTempDir(async (directory) => {
    const current = await write(directory, 'current.xml', urlset(AFTER));
    const legacyDigest = createHash('sha256');
    for (const url of BEFORE) legacyDigest.update(url).update('\n');
    const baselinePath = await write(directory, 'legacy.json', JSON.stringify({
      schemaVersion: 1,
      cohort: { count: BEFORE.length, digest: `sha256:${legacyDigest.digest('hex')}` },
    }));
    const report = await auditSitemap(current, { compare: baselinePath });
    assert.equal(report.comparison.evidence, 'legacy-digest-only');
    assert.equal(report.comparison.cohortChanged, null);
    assert.equal(report.comparison.status, 'incomplete');
    assert.equal(report.status, 'incomplete');
    const cliResult = spawnSync(process.execPath,
      [cli, current, '--compare', baselinePath, '--json'], { encoding: 'utf8' });
    assert.equal(cliResult.status, 2);
    assert.equal(JSON.parse(cliResult.stdout).status, 'incomplete');
  });
});

test('a malformed cohort section is rejected', async () => {
  await withTempDir(async (directory) => {
    const after = await write(directory, 'after.xml', urlset(AFTER));

    const badCount = await write(directory, 'bad-count.json', JSON.stringify({
      schemaVersion: 1,
      cohort: { count: 'three', digest: 'sha256:x' },
    }));
    await assert.rejects(auditSitemap(after, { compare: badCount }), /malformed cohort section/);

    const badUrls = await write(directory, 'bad-urls.json', JSON.stringify({
      schemaVersion: 1,
      cohort: { count: 1, digest: 'sha256:x', urls: [7] },
    }));
    await assert.rejects(auditSitemap(after, { compare: badUrls }), /malformed cohort/);
  });
});

test('an unreadable comparison input is incomplete with a private baseline label', async () => {
  await withTempDir(async (directory) => {
    const current = await write(directory, 'current.xml', urlset(AFTER));
    const missing = join(directory, 'token=SYNTHETIC_SECRET_CANARY.json');
    const result = spawnSync(process.execPath,
      [cli, current, '--compare', missing, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes('SYNTHETIC_SECRET_CANARY'), false);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'incomplete');
    assert.equal(report.source, 'baseline');
    assert.deepEqual(report.findings.map(({ rule }) => rule), ['input-unreadable']);
  });
});

test('a JSON file that is not one of our reports is treated as a sitemap source', async () => {
  await withTempDir(async (directory) => {
    const after = await write(directory, 'after.xml', urlset(AFTER));
    const notAReport = await write(directory, 'other.json', JSON.stringify({ hello: 'world' }));

    // Falls through to the sitemap reader, which rejects it as non-XML rather
    // than silently treating it as an empty cohort.
    await assert.rejects(auditSitemap(after, { compare: notAReport }));
  });
});

test('a sitemap index cycle terminates and is recorded', async () => {
  await withTempDir(async (directory) => {
    const parent = join(directory, 'parent.xml');
    const child = join(directory, 'child.xml');
    const asUrl = (path) => `file://${path}`;

    await writeFile(parent, `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${asUrl(child)}</loc></sitemap>
</sitemapindex>`);
    await writeFile(child, `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${asUrl(parent)}</loc></sitemap>
</sitemapindex>`);

    const report = await auditSitemap(parent);

    assert.equal(report.summary.documents, 2);
    assert.ok(report.skippedAlreadyVisited.length > 0);
  });
});
