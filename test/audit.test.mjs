import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

function xmlResponse(body, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('content-type', 'application/xml');
  return new Response(body, { ...options, headers });
}

function redirectResponse(status, location) {
  const headers = location === undefined ? undefined : { location };
  return new Response(null, { status, headers });
}

function fetchRouter(routes) {
  const calls = [];
  const fetch = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });
    const factory = routes[url];
    if (!factory) throw new Error(`Unexpected fetch: ${url}`);
    return factory();
  };
  return { calls, fetch };
}

function trackedBody(chunks) {
  let index = 0;
  let pulls = 0;
  let cancelled = false;
  const iterator = {
    async next() {
      pulls += 1;
      if (index >= chunks.length) return { done: true, value: undefined };
      const value = chunks[index];
      index += 1;
      return { done: false, value };
    },
    async return() {
      cancelled = true;
      return { done: true, value: undefined };
    },
  };
  return {
    body: {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      async cancel() {
        cancelled = true;
      },
    },
    get cancelled() {
      return cancelled;
    },
    get pulls() {
      return pulls;
    },
  };
}

function responseLike(body, { status = 200, headers = {} } = {}) {
  return {
    body,
    headers: new Headers(headers),
    ok: status >= 200 && status < 300,
    status,
    url: '',
  };
}

const unsafeTerminalPattern = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

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

test('remote graphs accept only normalized same-origin HTTPS children', async () => {
  const rootUrl = 'https://origin.test/maps/root.xml';
  const { calls, fetch } = fetchRouter({
    [rootUrl]: () => xmlResponse(sitemapIndex([
      'child.xml',
      '/absolute.xml',
      'https://ORIGIN.test:443/third.xml#ignored',
    ])),
    'https://origin.test/maps/child.xml': () => xmlResponse(urlset([
      'https://example.test/relative',
    ])),
    'https://origin.test/absolute.xml': () => xmlResponse(urlset([
      'https://example.test/absolute',
    ])),
    'https://origin.test/third.xml': () => xmlResponse(urlset([
      'https://example.test/third',
    ])),
  });

  const report = await auditSitemap(rootUrl, { fetch });

  assert.equal(report.summary.documents, 4);
  assert.deepEqual(calls.map(({ url }) => url), [
    rootUrl,
    'https://origin.test/maps/child.xml',
    'https://origin.test/absolute.xml',
    'https://origin.test/third.xml',
  ]);
  assert.ok(calls.every(({ options }) => options.redirect === 'manual'));
  assert.ok(calls.every(({ options }) => options.headers['accept-encoding'] === 'identity'));
});

test('remote graphs reject cross-origin, insecure, credentialed, and file children before access', async () => {
  const unsafeChildren = [
    'https://evil.test/child.xml',
    '//evil.test/child.xml',
    'https://cdn.origin.test/child.xml',
    'https://origin.test:444/child.xml',
    'https://origin.test@evil.test/child.xml',
    'https://user:secret@origin.test/child.xml',
    'http://origin.test/child.xml',
    pathToFileURL(root).href,
  ];

  for (const child of unsafeChildren) {
    const rootUrl = 'https://origin.test/root.xml';
    const { calls, fetch } = fetchRouter({
      [rootUrl]: () => xmlResponse(sitemapIndex([child])),
    });

    await assert.rejects(
      auditSitemap(rootUrl, { fetch }),
      /same-origin HTTPS|must not include credentials/,
      child,
    );
    assert.deepEqual(calls.map(({ url }) => url), [rootUrl], child);
  }

  let fetched = false;
  await assert.rejects(
    auditSitemap('https://user:secret@origin.test/root.xml', {
      fetch: async () => {
        fetched = true;
        return xmlResponse(urlset());
      },
    }),
    /must not include credentials/,
  );
  assert.equal(fetched, false);
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
  assert.deepEqual(report.skippedAlreadyVisited, [child]);
});

test('local sitemap indexes cannot initiate remote requests', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-auditor-local-remote-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = join(directory, 'index.xml');
  await writeFile(index, sitemapIndex(['https://origin.test/child.xml']));
  let fetched = false;

  await assert.rejects(
    auditSitemap(index, {
      fetch: async () => {
        fetched = true;
        return xmlResponse(urlset());
      },
    }),
    /Local sitemap indexes may reference only local child files/,
  );
  assert.equal(fetched, false);
});

test('current and comparison remote roots enforce separate origins', async () => {
  const currentUrl = 'https://current.test/root.xml';
  const previousUrl = 'https://previous.test/root.xml';
  const { calls, fetch } = fetchRouter({
    [currentUrl]: () => xmlResponse(urlset(['https://example.test/current'])),
    [previousUrl]: () => xmlResponse(urlset(['https://example.test/previous'])),
  });

  const report = await auditSitemap(currentUrl, { compare: previousUrl, fetch });

  assert.equal(report.comparison.addedCount, 1);
  assert.equal(report.comparison.removedCount, 1);
  assert.deepEqual(calls.map(({ url }) => url), [currentUrl, previousUrl]);
});

test('manually follows standard same-origin redirect statuses', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const rootUrl = `https://origin.test/${status}/root.xml`;
    const finalUrl = `https://origin.test/${status}/final.xml`;
    const { calls, fetch } = fetchRouter({
      [rootUrl]: () => redirectResponse(status, 'final.xml'),
      [finalUrl]: () => xmlResponse(urlset(['https://example.test/page'])),
    });

    const report = await auditSitemap(rootUrl, { fetch });

    assert.equal(report.summary.uniqueUrls, 1);
    assert.deepEqual(calls.map(({ url }) => url), [rootUrl, finalUrl]);
    assert.ok(calls.every(({ options }) => options.redirect === 'manual'));
  }
});

test('uses the final same-origin redirect URL as the relative-child base', async () => {
  const rootUrl = 'https://origin.test/root.xml';
  const redirectedUrl = 'https://origin.test/maps/root.xml';
  const childUrl = 'https://origin.test/maps/child.xml';
  const { calls, fetch } = fetchRouter({
    [rootUrl]: () => redirectResponse(302, '/maps/root.xml'),
    [redirectedUrl]: () => xmlResponse(sitemapIndex(['child.xml'])),
    [childUrl]: () => xmlResponse(urlset(['https://example.test/page'])),
  });

  const report = await auditSitemap(rootUrl, { fetch });

  assert.equal(report.summary.uniqueUrls, 1);
  assert.deepEqual(calls.map(({ url }) => url), [rootUrl, redirectedUrl, childUrl]);
});

test('rejects unsafe redirects before requesting their targets', async () => {
  const locations = [
    'http://origin.test/final.xml',
    'https://evil.test/final.xml',
    'https://origin.test:444/final.xml',
    'https://user:secret@origin.test/final.xml',
    'file:///tmp/final.xml',
  ];

  for (const location of locations) {
    const rootUrl = 'https://origin.test/root.xml';
    const { calls, fetch } = fetchRouter({
      [rootUrl]: () => redirectResponse(302, location),
    });

    await assert.rejects(
      auditSitemap(rootUrl, { fetch }),
      /same-origin HTTPS|must not include credentials/,
      location,
    );
    assert.deepEqual(calls.map(({ url }) => url), [rootUrl], location);
  }

  const tracked = trackedBody([Buffer.from('redirect body')]);
  const rootUrl = 'https://origin.test/cancel.xml';
  const cancellation = fetchRouter({
    [rootUrl]: () => responseLike(tracked.body, {
      status: 302,
      headers: { location: 'http://origin.test/final.xml' },
    }),
  });
  await assert.rejects(
    auditSitemap(rootUrl, { fetch: cancellation.fetch }),
    /same-origin HTTPS/,
  );
  assert.equal(tracked.pulls, 0);
  assert.equal(tracked.cancelled, true);
});

test('rejects fetch implementations that follow redirects despite manual mode', async () => {
  const rootUrl = 'https://origin.test/root.xml';
  const body = trackedBody([Buffer.from(urlset())]);
  const fetch = async () => ({
    ...responseLike(body.body),
    url: 'https://origin.test/final.xml',
  });

  await assert.rejects(
    auditSitemap(rootUrl, { fetch }),
    /followed a redirect unexpectedly/,
  );
  assert.equal(body.pulls, 0);
  assert.equal(body.cancelled, true);
});

test('enforces the redirect bound, accepts the exact bound, and detects loops', async () => {
  const exact = fetchRouter({
    'https://origin.test/a': () => redirectResponse(302, '/b'),
    'https://origin.test/b': () => redirectResponse(307, '/c'),
    'https://origin.test/c': () => xmlResponse(urlset()),
  });
  await auditSitemap('https://origin.test/a', { fetch: exact.fetch, maxRedirects: 2 });
  assert.equal(exact.calls.length, 3);

  const excessive = fetchRouter({
    'https://origin.test/a': () => redirectResponse(302, '/b'),
    'https://origin.test/b': () => redirectResponse(302, '/c'),
    'https://origin.test/c': () => redirectResponse(302, '/d'),
  });
  await assert.rejects(
    auditSitemap('https://origin.test/a', { fetch: excessive.fetch, maxRedirects: 2 }),
    /2-redirect limit/,
  );
  assert.equal(excessive.calls.length, 3);

  const zero = fetchRouter({
    'https://origin.test/a': () => redirectResponse(302, '/b'),
  });
  await assert.rejects(
    auditSitemap('https://origin.test/a', { fetch: zero.fetch, maxRedirects: 0 }),
    /0-redirect limit/,
  );
  assert.equal(zero.calls.length, 1);

  const loop = fetchRouter({
    'https://origin.test/a': () => redirectResponse(302, '/b'),
    'https://origin.test/b': () => redirectResponse(302, '/a'),
  });
  await assert.rejects(
    auditSitemap('https://origin.test/a', { fetch: loop.fetch }),
    /redirect loop/,
  );
  assert.equal(loop.calls.length, 2);
});

test('rejects malformed redirects and does not follow unrelated 3xx statuses', async () => {
  const missing = fetchRouter({
    'https://origin.test/root.xml': () => redirectResponse(302),
  });
  await assert.rejects(
    auditSitemap('https://origin.test/root.xml', { fetch: missing.fetch }),
    /did not include a Location/,
  );

  const malformed = fetchRouter({
    'https://origin.test/root.xml': () => redirectResponse(302, 'https://[invalid'),
  });
  await assert.rejects(
    auditSitemap('https://origin.test/root.xml', { fetch: malformed.fetch }),
    /Invalid redirect Location/,
  );

  for (const status of [300, 304]) {
    const rootUrl = `https://origin.test/${status}.xml`;
    const router = fetchRouter({
      [rootUrl]: () => new Response(null, { status }),
    });
    await assert.rejects(
      auditSitemap(rootUrl, { fetch: router.fetch }),
      new RegExp(`HTTP ${status}`),
    );
    assert.equal(router.calls.length, 1);
  }
});

test('requires a complete 200 response and identity Content-Encoding', async () => {
  const rootUrl = 'https://origin.test/root.xml';
  const partial = fetchRouter({
    [rootUrl]: () => xmlResponse(urlset(), { status: 206 }),
  });
  await assert.rejects(
    auditSitemap(rootUrl, { fetch: partial.fetch }),
    /HTTP 206/,
  );

  const tracked = trackedBody([Buffer.from(urlset())]);
  const encoded = fetchRouter({
    [rootUrl]: () => responseLike(tracked.body, {
      headers: { 'content-encoding': 'gzip' },
    }),
  });
  await assert.rejects(
    auditSitemap(rootUrl, { fetch: encoded.fetch }),
    /Unsupported Content-Encoding/,
  );
  assert.equal(tracked.pulls, 0);
  assert.equal(tracked.cancelled, true);
});

test('rejects an oversized declared response before reading its body', async () => {
  const tracked = trackedBody([Buffer.from(urlset())]);
  const rootUrl = 'https://origin.test/root.xml';
  const { fetch } = fetchRouter({
    [rootUrl]: () => responseLike(tracked.body, {
      headers: { 'content-length': '65' },
    }),
  });

  await assert.rejects(
    auditSitemap(rootUrl, { fetch, maxXmlBytes: 64 }),
    /declares a response larger than 64 bytes/,
  );
  assert.equal(tracked.pulls, 0);
  assert.equal(tracked.cancelled, true);
});

test('enforces streamed response bytes without trusting Content-Length', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    const chunks = Array.from({ length: 20 }, () => Buffer.alloc(16, 0x20));
    const tracked = trackedBody(chunks);
    const rootUrl = 'https://origin.test/root.xml';
    const { fetch } = fetchRouter({
      [rootUrl]: () => responseLike(tracked.body, { headers }),
    });

    await assert.rejects(
      auditSitemap(rootUrl, { fetch, maxXmlBytes: 32 }),
      /exceeds the 32 bytes input limit/,
    );
    assert.ok(tracked.pulls < chunks.length, `pulls=${tracked.pulls}`);
    assert.equal(tracked.cancelled, true);
  }

  const xml = urlset(['https://example.test/malformed-length']);
  const tracked = trackedBody([Buffer.from(xml)]);
  const rootUrl = 'https://origin.test/malformed-length.xml';
  const malformedLength = fetchRouter({
    [rootUrl]: () => responseLike(tracked.body, {
      headers: { 'content-length': 'not-a-number' },
    }),
  });
  const report = await auditSitemap(rootUrl, {
    fetch: malformedLength.fetch,
    maxXmlBytes: Buffer.byteLength(xml),
  });
  assert.equal(report.summary.uniqueUrls, 1);
});

test('allows plain XML exactly at the byte limit and rejects limit plus one', async () => {
  const xml = urlset(['https://example.test/雪é😀']);
  const size = Buffer.byteLength(xml);
  const rootUrl = 'https://origin.test/root.xml';
  const passing = fetchRouter({
    [rootUrl]: () => xmlResponse(xml),
  });

  const report = await auditSitemap(rootUrl, {
    fetch: passing.fetch,
    maxXmlBytes: size,
  });
  assert.equal(report.summary.uniqueUrls, 1);

  const failing = fetchRouter({
    [rootUrl]: () => xmlResponse(xml),
  });
  await assert.rejects(
    auditSitemap(rootUrl, { fetch: failing.fetch, maxXmlBytes: size - 1 }),
    new RegExp(`exceeds the ${size - 1} bytes input limit`),
  );
});

test('bounds gzip expansion while accepting gzip magic split across chunks', async () => {
  const oversizedXml = `<urlset>${' '.repeat(1_024)}</urlset>`;
  const oversizedGzip = gzipSync(oversizedXml);
  assert.ok(oversizedGzip.length < 128);
  const rootUrl = 'https://origin.test/root.xml';
  const oversized = fetchRouter({
    [rootUrl]: () => xmlResponse(oversizedGzip),
  });

  await assert.rejects(
    auditSitemap(rootUrl, { fetch: oversized.fetch, maxXmlBytes: 128 }),
    /exceeds the 128 bytes uncompressed document limit/,
  );

  const validXml = `<urlset>${' '.repeat(256)}<url><loc>https://example.test/雪é😀</loc></url></urlset>`;
  const validGzip = gzipSync(validXml);
  assert.ok(validGzip.length < Buffer.byteLength(validXml));
  const split = trackedBody([
    validGzip.subarray(0, 1),
    validGzip.subarray(1, 2),
    validGzip.subarray(2),
  ]);
  const valid = fetchRouter({
    [rootUrl]: () => responseLike(split.body),
  });

  const report = await auditSitemap(rootUrl, {
    fetch: valid.fetch,
    maxXmlBytes: Buffer.byteLength(validXml),
  });
  assert.equal(report.summary.uniqueUrls, 1);

  const rawOverflow = trackedBody([
    Buffer.from([0x1f, 0x8b]),
    Buffer.alloc(20),
    Buffer.alloc(20),
  ]);
  const overflow = fetchRouter({
    [rootUrl]: () => responseLike(rawOverflow.body),
  });
  await assert.rejects(
    auditSitemap(rootUrl, { fetch: overflow.fetch, maxXmlBytes: 10 }),
    /exceeds the 10 bytes input limit/,
  );
  assert.equal(rawOverflow.cancelled, true);

  const truncatedGzip = validGzip.subarray(0, validGzip.length - 4);
  const truncated = fetchRouter({
    [rootUrl]: () => xmlResponse(truncatedGzip),
  });
  await assert.rejects(
    auditSitemap(rootUrl, {
      fetch: truncated.fetch,
      maxXmlBytes: Buffer.byteLength(validXml),
    }),
    /Could not decompress/,
  );
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
      /maxRedirects must be an integer/,
    );
  }
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

test('CLI usage and runtime errors escape hostile terminal input', () => {
  const unsafeOption = '--bad-\x1b[31m\nforged';
  const usage = spawnSync(process.execPath, [cli, unsafeOption], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.equal(usage.stderr.includes('\x1b'), false);
  assert.match(usage.stderr, /\\u001B/);
  assert.match(usage.stderr, /\\u000A/);

  const unsafePath = resolve(projectDirectory, 'missing-\x1b[31m\r.xml');
  const runtime = spawnSync(process.execPath, [cli, unsafePath, '--json'], { encoding: 'utf8' });
  assert.equal(runtime.status, 1);
  assert.equal(runtime.stdout, '');
  assert.equal(runtime.stderr.includes('\x1b'), false);
  assert.equal(runtime.stderr.includes('\r'), false);
  assert.match(runtime.stderr, /\\u001B/);
  assert.match(runtime.stderr, /\\u000D/);
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
