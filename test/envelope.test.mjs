import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as audit from '../lib/audit.mjs';
import { evaluatePolicy } from '../lib/policy.mjs';

const { auditSitemap } = audit;

async function withTemp(run) {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-envelope-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a complete clean export has a truthful checked count and empty findings', async () => {
  await withTemp(async (directory) => {
    const path = join(directory, 'clean.xml');
    await writeFile(path, '<urlset><url><loc>https://example.test/a</loc></url></urlset>');
    const report = await auditSitemap(path);
    assert.equal(report.tool, 'sitemap-cohort-auditor');
    assert.equal(report.status, 'pass');
    assert.equal(report.summary.checked, 1);
    assert.equal(report.summary.errors, 0);
    assert.equal(report.summary.warnings, 0);
    assert.deepEqual(report.findings, []);
  });
});

test('quality, policy and unknown evidence yield source-only ordered findings', async () => {
  await withTemp(async (directory) => {
    const path = join(directory, 'quality.xml');
    await writeFile(path, `<urlset>
      <url><loc>https://example.test/a#fragment</loc><lastmod>bad-date</lastmod></url>
      <url><loc>https://example.test/a#fragment</loc></url>
      <url><loc>not-a-url</loc></url>
      <url></url>
    </urlset>`);
    const report = await auditSitemap(path);
    assert.equal(report.summary.checked, 1);
    assert.equal(report.summary.errors, 0);
    assert.equal(report.summary.warnings, 6);
    assert.deepEqual(report.findings.map(({ ruleId }) => ruleId), [
      'duplicate-url', 'url-fragment', 'url-fragment', 'lastmod-invalid',
      'invalid-url', 'loc-missing',
    ]);
    const keys = report.findings.map(({ location, ruleId }) =>
      `${location.file}/${location.pointer}/${ruleId}`);
    assert.deepEqual(keys, [...keys].sort((a, b) => a === b ? 0 : a < b ? -1 : 1));
    assert.ok(report.findings.every(({ severity, location }) =>
      severity === 'warning' && location.file === 'current'
      && location.pointer.startsWith('/')));
    assert.equal(JSON.stringify(report).includes('bad-date'), false);

    report.policy = { ...evaluatePolicy(report, {
      schemaVersion: 1, maxInvalidUrls: 0,
    }), source: 'policy' };
    audit.completeReportEnvelope(report);
    assert.equal(report.status, 'fail');
    assert.equal(report.summary.errors, 1);
    assert.ok(report.findings.some(({ ruleId, severity }) =>
      ruleId === 'policy-max-invalid-urls' && severity === 'error'));
  });
});

test('incomplete host evidence preserves known policy findings but cannot pass', async () => {
  await withTemp(async (directory) => {
    const path = join(directory, 'partial.xml');
    await writeFile(path, '<urlset><url><loc>not-a-url</loc></url></urlset>');
    const report = await auditSitemap(path);
    report.policy = { ...evaluatePolicy(report, {
      schemaVersion: 1, allowedHosts: ['example.test'],
    }), source: 'policy' };
    audit.completeReportEnvelope(report);
    assert.equal(report.status, 'incomplete');
    assert.equal(report.summary.checked, 1);
    assert.ok(report.findings.some(({ ruleId, severity }) =>
      ruleId === 'policy-evidence-incomplete' && severity === 'warning'));
  });
});

test('policy envelope finding explains observed and allowed lastmod counts', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/root.xml', import.meta.url));
  const report = await auditSitemap(fixture);
  assert.equal(report.summary.invalidLastmodValues, 3);
  report.policy = evaluatePolicy(report, {
    schemaVersion: 1, maxInvalidLastmodValues: 0,
  });
  audit.completeReportEnvelope(report);

  const finding = report.findings.find(({ ruleId }) =>
    ruleId === 'policy-max-invalid-lastmod-values');
  assert.equal(finding.message, 'Invalid lastmod values: 3; maximum 0');
  assert.equal(finding.message.includes(fixture), false);
  assert.deepEqual(finding.location, { file: 'policy', pointer: '/findings/0' });
});
