import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { auditSitemap, formatTextReport } from '../lib/audit.mjs';

async function withTemp(run) {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-deadline-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('injected monotone deadline accepts exactly N and stops at N plus one', async () => {
  await withTemp(async (directory) => {
    const path = join(directory, 'clean.xml');
    await writeFile(path, '<urlset><url><loc>https://example.test/a</loc></url></urlset>');
    for (const [elapsed, status] of [[10, 'pass'], [11, 'incomplete']]) {
      let calls = 0;
      const report = await auditSitemap(path, {
        timeoutMs: 10,
        now: () => calls++ === 0 ? 0 : elapsed,
      });
      assert.equal(report.status, status, `${elapsed} elapsed`);
      if (status === 'incomplete') {
        assert.equal(report.summary.checked, 0);
        assert.ok(report.findings.some(({ ruleId }) => ruleId === 'timeout-exceeded'));
      }
    }
  });
});

test('deadline during parser work retains observed invalid URL without claiming a full cohort', async () => {
  await withTemp(async (directory) => {
    const path = join(directory, 'many.xml');
    const entries = ['<url><loc>not-a-url</loc></url>',
      ...Array.from({ length: 60 }, (_, index) =>
        `<url><loc>https://example.test/${index}</loc></url>`)];
    await writeFile(path, `<urlset>${entries.join('')}</urlset>`);
    let reached = null;
    for (let budget = 0; budget <= 300; budget += 1) {
      let ticks = 0;
      const report = await auditSitemap(path, {
        timeoutMs: budget,
        now: () => ticks++,
      });
      if (report.status === 'incomplete' && report.summary.checked === 0
        && report.findings.some(({ ruleId }) => ruleId === 'invalid-url')) {
        reached = report;
        break;
      }
    }
    assert.ok(reached, 'parser deadline must be reachable after a known observation');
    assert.ok(reached.findings.some(({ ruleId }) => ruleId === 'timeout-exceeded'));
    assert.equal(reached.cohort, undefined);
    assert.equal(reached.comparison, undefined);
    assert.match(formatTextReport(reached), /Known observations:\n  invalid-url at current\//);
  });
});

test('baseline deadline keeps the completed current audit and withholds movement', async () => {
  await withTemp(async (directory) => {
    const current = join(directory, 'current.xml');
    const baseline = join(directory, 'baseline.xml');
    await writeFile(current, '<urlset><url><loc>not-a-url</loc></url></urlset>');
    await writeFile(baseline, '<urlset><url><loc>https://example.test/b</loc></url></urlset>');
    let reached = null;
    for (let budget = 0; budget <= 300; budget += 1) {
      let ticks = 0;
      const report = await auditSitemap(current, {
        compare: baseline, timeoutMs: budget, now: () => ticks++,
      });
      if (report.status === 'incomplete' && report.deadline?.source === 'baseline'
        && report.comparison?.evidence === 'timeout') {
        reached = report;
        break;
      }
    }
    assert.ok(reached, 'baseline deadline must be reachable after current completion');
    assert.equal(reached.summary.checked, 1);
    assert.equal(reached.cohort.count, 1);
    assert.equal(reached.comparison.addedCount, undefined);
    assert.ok(reached.findings.some(({ ruleId }) => ruleId === 'invalid-url'));
    assert.ok(reached.findings.some(({ ruleId }) => ruleId === 'cohort-movement-unknown'));
    assert.ok(reached.findings.some(({ ruleId }) => ruleId === 'timeout-exceeded'));
    assert.match(formatTextReport(reached), /timeout-exceeded: Analysis did not complete\./);
  });
});

test('CLI deadline has distinct incomplete and invalid-configuration exit shapes', async () => {
  await withTemp(async (directory) => {
    const path = join(directory, 'clean.xml');
    await writeFile(path, '<urlset><url><loc>https://example.test/a</loc></url></urlset>');
    const cli = new URL('../bin/sitemap-cohort-auditor.mjs', import.meta.url);
    const run = (...args) => spawnSync(process.execPath, [cli.pathname, path, ...args], {
      encoding: 'utf8',
    });
    const clean = run('--json');
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(JSON.parse(clean.stdout).status, 'pass');
    const maximum = run('--timeout-ms', '60000', '--json');
    assert.equal(maximum.status, 0, maximum.stderr);
    const timeout = run('--timeout-ms', '0', '--json');
    assert.equal(timeout.status, 2, timeout.stderr);
    const incomplete = JSON.parse(timeout.stdout);
    assert.equal(incomplete.status, 'incomplete');
    assert.ok(incomplete.findings.some(({ ruleId }) => ruleId === 'timeout-exceeded'));
    const invalid = run('--timeout-ms', '60001', '--json');
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, '');

    const policy = join(directory, 'policy.json');
    await writeFile(policy, JSON.stringify({ schemaVersion: 1, minUniqueUrls: 1 }));
    const partialPolicy = run('--timeout-ms', '0', '--policy', policy, '--json');
    assert.equal(partialPolicy.status, 2, partialPolicy.stderr);
    const policyReport = JSON.parse(partialPolicy.stdout);
    assert.equal(policyReport.status, 'incomplete');
    assert.deepEqual(policyReport.policy.incompleteRules, ['minUniqueUrls']);
    assert.deepEqual(policyReport.policy.findings, []);
  });
});

test('deadline during graph traversal preserves completed child observations', async () => {
  await withTemp(async (directory) => {
    const root = join(directory, 'index.xml');
    await writeFile(root, '<sitemapindex><sitemap><loc>first.xml</loc></sitemap><sitemap><loc>second.xml</loc></sitemap></sitemapindex>');
    await writeFile(join(directory, 'first.xml'), '<urlset><url><loc>not-a-url</loc></url></urlset>');
    await writeFile(join(directory, 'second.xml'), '<urlset><url><loc>https://example.test/b</loc></url></urlset>');
    let reached = null;
    for (let budget = 0; budget <= 300; budget += 1) {
      let ticks = 0;
      const report = await auditSitemap(root, {
        timeoutMs: budget,
        now: () => ticks++,
      });
      if (report.status === 'incomplete' && report.summary.checked === 2
        && report.findings.some(({ ruleId }) => ruleId === 'invalid-url')) {
        reached = report;
        break;
      }
    }
    assert.ok(reached, 'graph deadline must preserve the completed first child');
    assert.ok(reached.findings.some(({ ruleId }) => ruleId === 'timeout-exceeded'));
    assert.equal(reached.cohort, undefined);
  });
});

test('a throwing or non-monotone clock cannot leak a value or pass', async () => {
  await withTemp(async (directory) => {
    const path = join(directory, 'clean.xml');
    await writeFile(path, '<urlset><url><loc>https://example.test/a</loc></url></urlset>');
    for (const now of [
      () => { throw new Error('SYNTHETIC_CLOCK_CANARY'); },
      (() => { let calls = 0; return () => calls++ === 0 ? 5 : 4; })(),
      () => Number.NaN,
    ]) {
      const report = await auditSitemap(path, { now });
      assert.equal(report.status, 'incomplete');
      assert.ok(report.findings.some(({ ruleId }) => ruleId === 'clock-invalid'));
      assert.equal(JSON.stringify(report).includes('SYNTHETIC_CLOCK_CANARY'), false);
    }
  });
});
