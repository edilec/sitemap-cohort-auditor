import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  auditSitemap,
  escapeTerminalText,
  formatJsonReport,
  formatTextReport,
  isIsoLastmod,
} from '../lib/audit.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testDirectory, '..');
const fixtures = resolve(testDirectory, 'fixtures');
const root = resolve(fixtures, 'root.xml');
const old = resolve(fixtures, 'old.xml');
const cli = resolve(projectDirectory, 'bin/sitemap-cohort-auditor.mjs');

function sitemapIndex(locations) {
  return `<sitemapindex>${locations.map((location) => (
    `<sitemap><loc>${location}</loc></sitemap>`
  )).join('')}</sitemapindex>`;
}

function urlset(urls = []) {
  return `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;
}


const unsafeTerminalPattern = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

test('recursively audits sitemap indexes and reports quality signals', async () => {
  const report = await auditSitemap(root);

  assert.deepEqual(report.summary, {
    checked: 4,
    errors: 0,
    warnings: 7,
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
    { name: 'host-1', count: 2 },
    { name: 'host-2', count: 1 },
    { name: 'host-3', count: 1 },
  ]);
  assert.deepEqual(report.schemes, [
    { name: 'http', count: 1 },
    { name: 'https', count: 3 },
  ]);
  assert.equal(report.duplicates[0].urlOrdinal, 2);
  assert.equal(report.duplicates[0].count, 2);
});

test('compares exact decoded URL cohorts while projecting movement to ordinals', async () => {
  const report = await auditSitemap(root, { compare: old, withCohort: true });

  assert.deepEqual(report.comparison.added, [
    { urlOrdinal: 3 },
    { urlOrdinal: 4 },
    { urlOrdinal: 5 },
  ]);
  assert.deepEqual(report.comparison.removed, [{ baselineUrlOrdinal: 2 }]);
  assert.ok(report.cohort.urls.includes('https://www.edilec.com/new/#details'));
  assert.equal(report.comparison.addedCount, 3);
  assert.equal(report.comparison.removedCount, 1);
});

test('recognizes roots only after a valid leading XML preamble', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-auditor-preamble-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const valid = join(directory, 'valid.xml');
  await writeFile(valid, [
    '\uFEFF  \n<?xml version="1.0" encoding="UTF-8"?>\n',
    '<!-- first -->\n',
    '<!-- <?xml version="9.9"?><sitemapindex>decoy</sitemapindex> -->\n',
    '<urlset><url><loc>https://example.test/real</loc></url></urlset>',
  ].join(''));

  const report = await auditSitemap(valid);
  assert.equal(report.summary.documents, 1);
  assert.equal(report.summary.uniqueUrls, 1);
  assert.equal(report.documents[0].type, 'urlset');
});

test('rejects malformed declarations and leading comments', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-auditor-bad-preamble-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    {
      name: 'declaration.xml',
      xml: '<?xml version="1.0"<urlset></urlset>',
      error: /Malformed XML preamble: unterminated XML declaration/,
    },
    {
      name: 'comment.xml',
      xml: '<!-- never closed <urlset></urlset>',
      error: /Malformed XML preamble: unterminated comment/,
    },
    {
      name: 'nested-comment.xml',
      xml: '<!-- outer <!-- inner --> --><urlset></urlset>',
      error: /Malformed XML preamble: comments cannot contain "--"/,
    },
  ];

  for (const fixture of cases) {
    const path = join(directory, fixture.name);
    await writeFile(path, fixture.xml);
    await assert.rejects(auditSitemap(path), fixture.error);
  }
});

test('preserves CDATA scalar text without treating it as nested markup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-auditor-cdata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'sitemap.xml');
  await writeFile(path, [
    '<urlset>',
    '<url><loc><![CDATA[https://example.test/path?x=1&y=2]]></loc></url>',
    '<url><loc><![CDATA[<tag>]]></loc></url>',
    '<url><loc>&lt;b&gt;</loc></url>',
    '</urlset>',
  ].join(''));

  const report = await auditSitemap(path, { withCohort: true });
  assert.equal(report.summary.urlEntries, 3);
  assert.equal(report.summary.invalidUrls, 2);
  assert.deepEqual(report.invalidUrls.map(({ urlOrdinal }) => urlOrdinal), [2, 3]);
  assert.deepEqual(report.cohort.urls, ['<b>', '<tag>', 'https://example.test/path?x=1&y=2']);
  assert.deepEqual(report.hosts, [{ name: 'host-1', count: 1 }]);
});

test('rejects nested markup and unterminated CDATA in sitemap scalar fields', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-auditor-bad-scalar-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nested = join(directory, 'nested.xml');
  const cdata = join(directory, 'cdata.xml');
  await writeFile(nested, '<urlset><url><loc>https://e.test/<b>x</b></loc></url></urlset>');
  await writeFile(cdata, '<urlset><url><loc><![CDATA[https://e.test/</loc></url></urlset>');

  await assert.rejects(
    auditSitemap(nested),
    /Sitemap scalar values must not contain nested markup/,
  );
  await assert.rejects(
    auditSitemap(cdata),
    /Unterminated CDATA section in sitemap scalar value/,
  );
});

test('accepts W3C-style lastmod values and rejects invalid calendar values', () => {
  assert.equal(isIsoLastmod('2024-02-29'), true);
  assert.equal(isIsoLastmod('2026-08-10T12:30:00.123+05:30'), true);
  assert.equal(isIsoLastmod('2026-02-29'), false);
  assert.equal(isIsoLastmod('2026-08-10 12:30:00'), false);
  assert.equal(isIsoLastmod('2026-08-10T12:30:00+14:30'), false);
});


test('local sitemap indexes retain relative and file child support', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-auditor-local-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = join(directory, 'child.xml');
  const index = join(directory, 'index.xml');
  await writeFile(child, urlset(['https://example.test/local-child']));
  await writeFile(index, sitemapIndex(['child.xml', pathToFileURL(child).href]));

  const report = await auditSitemap(index);

  assert.equal(report.summary.documents, 2);
  assert.equal(report.summary.uniqueUrls, 1);
  assert.equal(report.skippedAlreadyVisited.length, 1);
});

test('local sitemap indexes cannot initiate remote requests', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-auditor-local-remote-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = join(directory, 'index.xml');
  await writeFile(index, sitemapIndex(['https://origin.test/child.xml']));
  await assert.rejects(
    auditSitemap(index),
    /Local sitemap indexes may reference only local child files/,
  );
});

test('library refuses remote roots and fetch injection before any callback', async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    throw new Error('callback must not run');
  };
  await assert.rejects(auditSitemap('https://example.test/map.xml', { fetch }),
    /local export|offline/i);
  await assert.rejects(auditSitemap(root, { fetch }), /fetch option|offline/i);
  assert.equal(called, false);
  const ordinary = await auditSitemap(root);
  assert.equal(ordinary.summary.documents, 4);
});

test('a remote child yields incomplete CLI evidence without any network request', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-remote-child-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = join(directory, 'index.xml');
  await writeFile(index, sitemapIndex(['https://example.test/remote.xml']));
  const result = spawnSync(process.execPath, [cli, index, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.findings[0].rule, 'input-invalid');
  assert.equal(result.stdout.includes('https://example.test/remote.xml'), false);
});

test('initial and child symlink escapes are incomplete, while an in-root child passes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-read-root-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inside = join(directory, 'inside');
  const outside = join(directory, 'outside');
  await Promise.all([mkdir(inside), mkdir(outside)]);
  const outsideFile = join(outside, 'outside.xml');
  await writeFile(outsideFile, urlset(['https://example.test/outside']));
  const outsideLink = join(inside, 'outside.xml');
  await symlink(outsideFile, outsideLink);
  const index = join(inside, 'index.xml');
  await writeFile(index, sitemapIndex(['outside.xml']));
  const initial = join(inside, 'initial.xml');
  await symlink(outsideFile, initial);
  for (const source of [initial, index]) {
    const result = spawnSync(process.execPath, [cli, source, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 2, source);
    assert.equal(JSON.parse(result.stdout).status, 'incomplete');
  }
  const valid = join(inside, 'valid.xml');
  await writeFile(valid, urlset(['https://example.test/inside']));
  await writeFile(index, sitemapIndex(['valid.xml']));
  const good = await auditSitemap(index);
  assert.equal(good.summary.documents, 2);
  const widened = await auditSitemap(index, { root: directory });
  assert.equal(widened.summary.documents, 2);
});


test('applies streamed limits to local plain and gzip documents', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-auditor-limits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const xml = `<urlset>${' '.repeat(256)}<url><loc>https://example.test/local</loc></url></urlset>`;
  const plainPath = join(directory, 'sitemap.xml');
  const gzipPath = join(directory, 'sitemap.xml.gz');
  await writeFile(plainPath, xml);
  await writeFile(gzipPath, gzipSync(xml));

  const plain = await auditSitemap(plainPath, { maxXmlBytes: Buffer.byteLength(xml) });
  const compressed = await auditSitemap(gzipPath, { maxXmlBytes: Buffer.byteLength(xml) });
  assert.equal(plain.summary.uniqueUrls, 1);
  assert.equal(compressed.summary.uniqueUrls, 1);

  await assert.rejects(
    auditSitemap(plainPath, { maxXmlBytes: Buffer.byteLength(xml) - 1 }),
    /input limit/,
  );
  await assert.rejects(
    auditSitemap(gzipPath, { maxXmlBytes: 128 }),
    /uncompressed document limit/,
  );
});

test('validates injectable safety limits before reading input', async () => {
  for (const maxXmlBytes of [0, -1, 1.5, Number.NaN, '32', 50 * 1024 * 1024 + 1]) {
    await assert.rejects(
      auditSitemap(root, { maxXmlBytes }),
      /maxXmlBytes must be an integer/,
    );
  }
  for (const maxRedirects of [-1, 1.5, Number.NaN, '2', 6]) {
    await assert.rejects(
      auditSitemap(root, { maxRedirects }),
      /fetch option is unsupported/,
    );
  }
});

test('explicit root widens local comparison scope but file root is invalid configuration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-explicit-root-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const currentDir = join(directory, 'current');
  const oldDir = join(directory, 'old');
  await Promise.all([mkdir(currentDir), mkdir(oldDir)]);
  const current = join(currentDir, 'map.xml');
  const previous = join(oldDir, 'map.xml');
  await writeFile(current, urlset(['https://example.test/new']));
  await writeFile(previous, urlset(['https://example.test/old']));
  const narrow = spawnSync(process.execPath,
    [cli, current, '--compare', previous, '--json'], { encoding: 'utf8' });
  assert.equal(narrow.status, 2);
  const narrowReport = JSON.parse(narrow.stdout);
  assert.equal(narrowReport.source, 'current');
  assert.equal(narrowReport.summary.checked, 1);
  assert.equal(narrowReport.comparison.source, 'baseline');
  assert.equal(narrowReport.comparison.status, 'incomplete');
  const widened = spawnSync(process.execPath,
    [cli, current, '--root', directory, '--compare', previous, '--json'], { encoding: 'utf8' });
  assert.equal(widened.status, 0, widened.stderr);
  assert.equal(JSON.parse(widened.stdout).comparison.addedCount, 1);
  const badRoot = spawnSync(process.execPath,
    [cli, current, '--root', current, '--json'], { encoding: 'utf8' });
  assert.equal(badRoot.status, 2);
  assert.equal(badRoot.stdout, '');
});

test('default reports use ordinals instead of private URL and file values', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-private-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canary = 'SYNTHETIC_SECRET_CANARY';
  const current = join(directory, `token=${canary}.xml`);
  const baseline = join(directory, 'baseline.xml');
  const policy = join(directory, 'policy.json');
  const currentUrl = `https://hidden.test/?token=${canary}`;
  await writeFile(current, `<urlset>
    <url><loc>${currentUrl}</loc><lastmod>token=${canary}</lastmod></url>
    <url><loc>${currentUrl}</loc></url>
    <url><loc>${currentUrl}#part</loc></url>
  </urlset>`);
  await writeFile(baseline, urlset([`https://old.test/?token=${canary}`]));
  await writeFile(policy, JSON.stringify({ schemaVersion: 1, allowedHosts: ['example.test'] }));

  for (const format of ['--json', '']) {
    const args = [cli, current, '--compare', baseline, '--policy', policy];
    if (format) args.push(format);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout.includes(canary), false);
    assert.equal(result.stdout.includes('hidden.test'), false);
    assert.equal(result.stdout.includes('old.test'), false);
    assert.equal(result.stdout.includes(directory), false);
    if (format) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.source, 'current');
      assert.equal(report.comparison.source, 'baseline');
      assert.equal(report.policy.source, 'policy');
      assert.equal(report.comparison.addedCount, 2);
      assert.equal(report.comparison.removedCount, 1);
      assert.equal(report.cohort.urls, undefined);
      assert.deepEqual(report.documents.map(({ source }) => source), ['document-1']);
      assert.ok(report.duplicates.every(({ urlOrdinal }) => Number.isInteger(urlOrdinal)));
      assert.ok(report.policy.findings.some(({ code }) => code === 'DISALLOWED_HOST'));
    }
  }

  const explicit = spawnSync(process.execPath,
    [cli, current, '--with-cohort', '--json'], { encoding: 'utf8' });
  assert.equal(explicit.status, 0);
  assert.ok(JSON.parse(explicit.stdout).cohort.urls.includes(currentUrl));
});

test('terminal escaping neutralizes control and bidi characters while preserving Unicode', () => {
  const value = '雪é😀 العربية\n\r\t\x1b[31m\u009b\u202e\uFEFF\u{E0001}';
  const escaped = escapeTerminalText(value);

  assert.equal(
    escaped,
    '雪é😀 العربية\\u000A\\u000D\\u0009\\u001B[31m\\u009B\\u202E\\uFEFF\\uDB40\\uDC01',
  );
  assert.equal(unsafeTerminalPattern.test(escaped), false);
});

test('text reports sanitize every untrusted field and remain deterministic', () => {
  const unsafe = '雪é😀\x1b[31m\r\u009b\u202e';
  const report = {
    source: `source-${unsafe}`,
    summary: {
      documents: 1,
      sitemapReferences: 0,
      urlEntries: 2,
      uniqueUrls: 1,
      duplicateUrls: 1,
      duplicateUrlEntries: 1,
      imageEntries: 0,
      uniqueImages: 0,
      lastmodValues: 1,
      invalidLastmodValues: 1,
      fragmentUrls: 1,
      invalidUrls: 0,
      missingLocs: 0,
    },
    hosts: [{ name: `host-${unsafe}`, count: 1 }],
    schemes: [{ name: `scheme-${unsafe}`, count: 1 }],
    duplicates: [{ url: `duplicate-${unsafe}`, count: 2, sources: [] }],
    invalidLastmods: [{ value: `value-${unsafe}`, url: `lastmod-${unsafe}` }],
    fragments: [{ url: `fragment-${unsafe}` }],
    comparison: {
      source: `compare-${unsafe}`,
      previousUniqueUrls: 1,
      addedCount: 1,
      removedCount: 1,
      added: [`added-${unsafe}`],
      removed: [`removed-${unsafe}`],
    },
  };

  const first = formatTextReport(report);
  const second = formatTextReport(report);
  assert.equal(first, second);
  assert.equal(unsafeTerminalPattern.test(first), false);
  assert.match(first, /雪é😀/u);
  assert.match(first, /\\u001B/);
  assert.match(first, /\\u009B/);
  assert.match(first, /\\u202E/);
});

test('terminal-safe JSON is deterministic, parseable, and semantically lossless', () => {
  const value = '雪é😀\x1b\u009b\u202e\uFEFF\u{E0001}';
  const report = { value };
  const first = formatJsonReport(report);
  const second = formatJsonReport(report);

  assert.equal(first, second);
  assert.deepEqual(JSON.parse(first), report);
  assert.match(first, /雪é😀/u);
  assert.equal(first.includes('\x1b'), false);
  assert.equal(first.includes('\u009b'), false);
  assert.equal(first.includes('\u202e'), false);
  assert.equal(first.includes('\uFEFF'), false);
  assert.equal(first.includes('\u{E0001}'), false);
  assert.match(first, /\\u001b/);
  assert.match(first, /\\u009B/);
  assert.match(first, /\\u202E/);
  assert.match(first, /\\uFEFF/);
  assert.match(first, /\\uDB40\\uDC01/);
});

test('CLI usage errors escape controls and unreadable input hides hostile paths', () => {
  const unsafeOption = '--bad-\x1b[31m\nforged';
  const usage = spawnSync(process.execPath, [cli, unsafeOption], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.equal(usage.stderr.includes('\x1b'), false);
  assert.match(usage.stderr, /\\u001B/);
  assert.match(usage.stderr, /\\u000A/);

  const unsafePath = resolve(projectDirectory, 'missing-\x1b[31m\r.xml');
  const runtime = spawnSync(process.execPath, [cli, unsafePath, '--json'], { encoding: 'utf8' });
  assert.equal(runtime.status, 2);
  assert.equal(runtime.stderr, '');
  assert.equal(runtime.stdout.includes('missing-'), false);
  assert.equal(runtime.stdout.includes('\x1b'), false);
  assert.equal(JSON.parse(runtime.stdout).status, 'incomplete');
});

test('unreadable sitemap emits incomplete report without disclosing its filename', () => {
  const missing = resolve(projectDirectory, 'token=SYNTHETIC_SECRET_CANARY.xml');
  for (const flag of ['--json', '']) {
    const args = [cli, missing];
    if (flag) args.push(flag);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.length > 0);
    assert.equal(result.stdout.includes('SYNTHETIC_SECRET_CANARY'), false);
    if (flag) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, 'incomplete');
      assert.equal(report.source, 'current');
      assert.deepEqual(report.findings.map(({ rule }) => rule), ['input-unreadable']);
    }
  }
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

test('remote source configuration is refused without an input report', () => {
  const result = spawnSync(process.execPath, [cli, 'http://example.com/sitemap.xml'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Local sitemap input is required/);
});
