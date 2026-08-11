import { createReadStream } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

export const VERSION = '0.1.1';

const MAX_DOCUMENTS = 10_000;
const MAX_XML_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class DocumentLimitError extends Error {}

function formatByteLimit(bytes) {
  if (bytes === 50 * 1024 * 1024) return '50 MiB';
  return `${bytes.toLocaleString('en-US')} bytes`;
}

function validatedLimit(value, fallback, name, minimum = 1) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > fallback) {
    throw new Error(`${name} must be an integer from ${minimum} to ${fallback}`);
  }
  return value;
}

function createRuntime(options) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new Error('A Fetch API implementation is required for HTTPS sitemap input');
  }

  return {
    fetch: fetchImplementation,
    maxXmlBytes: validatedLimit(options.maxXmlBytes, MAX_XML_BYTES, 'maxXmlBytes'),
    maxRedirects: validatedLimit(options.maxRedirects, MAX_REDIRECTS, 'maxRedirects', 0),
  };
}

function terminalEscape(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint <= 0xFFFF) {
    return `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return [...character]
    .flatMap((value) => {
      const point = value.codePointAt(0) - 0x10000;
      return [0xD800 + (point >> 10), 0xDC00 + (point & 0x3FF)];
    })
    .map((codeUnit) => `\\u${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`)
    .join('');
}

export function escapeTerminalText(value) {
  return String(value).replace(
    /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu,
    terminalEscape,
  );
}

export function formatJsonReport(report) {
  const json = JSON.stringify(report, null, 2)
    .replace(
      /[\u007F-\u009F\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu,
      terminalEscape,
    );
  return `${json}\n`;
}

function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
      const named = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
      };
      const lower = entity.toLowerCase();
      if (named[lower]) return named[lower];

      const hexadecimal = lower.startsWith('&#x');
      const digits = entity.slice(hexadecimal ? 3 : 2, -1);
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      try {
        return Number.isInteger(codePoint) ? String.fromCodePoint(codePoint) : entity;
      } catch {
        return entity;
      }
    });
}

function cleanText(value) {
  const withoutCdataMarkers = value.replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>/g,
    (_match, content) => content,
  );
  return decodeXml(withoutCdataMarkers.replace(/<[^>]*>/g, '')).trim();
}

function extractBlocks(xml, localName) {
  const expression = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}\\s*>`,
    'gi',
  );
  return [...xml.matchAll(expression)].map((match) => match[1]);
}

function extractTagMatches(xml, localName) {
  const expression = new RegExp(
    `<((?:[A-Za-z_][\\w.-]*:)?${localName})\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}\\s*>`,
    'gi',
  );
  return [...xml.matchAll(expression)].map((match) => ({
    qualifiedName: match[1].toLowerCase(),
    value: cleanText(match[2]),
  }));
}

function extractPrimaryLoc(block) {
  const matches = extractTagMatches(block, 'loc');
  const primary = matches.find(({ qualifiedName }) => qualifiedName !== 'image:loc');
  return primary?.value ?? null;
}

function extractImageLocs(block) {
  return extractTagMatches(block, 'loc')
    .filter(({ qualifiedName }) => qualifiedName === 'image:loc')
    .map(({ value }) => value);
}

function extractLastmods(block) {
  return extractTagMatches(block, 'lastmod').map(({ value }) => value);
}

function documentKind(xml) {
  const withoutPreamble = xml
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .trimStart();

  if (/^<(?:[A-Za-z_][\w.-]*:)?sitemapindex\b/i.test(withoutPreamble)) return 'sitemapindex';
  if (/^<(?:[A-Za-z_][\w.-]*:)?urlset\b/i.test(withoutPreamble)) return 'urlset';
  throw new Error('XML root must be <urlset> or <sitemapindex>');
}

function isGzip(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

async function* limitedChunks(iterable, maximumBytes, source) {
  let total = 0;

  for await (const value of iterable) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > maximumBytes) {
      throw new DocumentLimitError(
        `${source} exceeds the ${formatByteLimit(maximumBytes)} input limit`,
      );
    }
    yield chunk;
  }
}

async function peekStream(iterable, byteCount) {
  const iterator = iterable[Symbol.asyncIterator]();
  const prefixChunks = [];
  let prefixLength = 0;

  try {
    while (prefixLength < byteCount) {
      const next = await iterator.next();
      if (next.done) break;
      prefixChunks.push(next.value);
      prefixLength += next.value.length;
    }
  } catch (error) {
    if (typeof iterator.return === 'function') await iterator.return();
    throw error;
  }

  const prefix = Buffer.concat(prefixChunks, prefixLength);
  async function* replay() {
    try {
      if (prefix.length > 0) yield prefix;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      if (typeof iterator.return === 'function') await iterator.return();
    }
  }

  return { prefix, readable: Readable.from(replay()) };
}

async function collectDecodedStream(readable, maximumBytes, source, compressed, signal) {
  const chunks = [];
  let total = 0;
  const collector = new Writable({
    write(value, _encoding, callback) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.length;
      if (total > maximumBytes) {
        callback(new DocumentLimitError(
          `${source} exceeds the ${formatByteLimit(maximumBytes)} uncompressed document limit`,
        ));
        return;
      }
      chunks.push(chunk);
      callback();
    },
  });
  const decompressor = compressed ? createGunzip() : null;
  const pipelineOptions = signal ? [{ signal }] : [];

  try {
    if (decompressor) await pipeline(readable, decompressor, collector, ...pipelineOptions);
    else await pipeline(readable, collector, ...pipelineOptions);
  } catch (error) {
    if (error instanceof DocumentLimitError) throw error;
    if (signal?.aborted) {
      throw new Error(`Could not fetch ${source}: request timed out after 30 seconds`);
    }
    if (compressed) {
      throw new Error(`Could not decompress ${source}: ${error.message}`);
    }
    throw error;
  }

  return Buffer.concat(chunks, total);
}

async function decodeDocumentStream(iterable, source, maximumBytes, signal) {
  const limited = limitedChunks(iterable, maximumBytes, source);
  const { prefix, readable } = await peekStream(limited, 2);
  const compressed = isGzip(prefix);
  const content = await collectDecodedStream(readable, maximumBytes, source, compressed, signal);

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    throw new Error(`Could not decode ${source} as UTF-8: ${error.message}`);
  }
}

function normalizeInitialSource(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    parsed = null;
  }

  if (parsed?.protocol === 'https:') {
    if (parsed.username || parsed.password) {
      throw new Error('Remote sitemap URLs must not include credentials');
    }
    parsed.hash = '';
    return { kind: 'https', id: parsed.href, origin: parsed.origin };
  }
  if (parsed?.protocol === 'file:') {
    const path = resolve(fileURLToPath(parsed));
    return { kind: 'file', id: path };
  }
  if (parsed) {
    throw new Error(`Unsupported source protocol "${parsed.protocol}"; use a local file or HTTPS URL`);
  }

  return { kind: 'file', id: resolve(input) };
}

function resolveChildSource(loc, parent) {
  if (parent.kind === 'https') {
    let child;
    try {
      child = new URL(loc, parent.id);
    } catch {
      throw new Error(`Invalid child sitemap URL in ${parent.id}: ${loc}`);
    }
    if (child.username || child.password) {
      throw new Error('Remote sitemap child URLs must not include credentials');
    }
    if (child.protocol !== 'https:' || child.origin !== parent.origin) {
      throw new Error(
        `Remote sitemap children must use same-origin HTTPS: ${child.href}`,
      );
    }
    child.hash = '';
    return { kind: 'https', id: child.href, origin: parent.origin };
  }

  let parsed;
  try {
    parsed = new URL(loc);
  } catch {
    parsed = null;
  }

  if (parsed?.protocol === 'https:') {
    throw new Error(
      `Local sitemap indexes may reference only local child files: ${parsed.href}`,
    );
  }
  if (parsed?.protocol === 'file:') {
    return { kind: 'file', id: resolve(fileURLToPath(parsed)) };
  }
  if (parsed) {
    throw new Error(`Unsupported child sitemap protocol "${parsed.protocol}" in ${parent.id}`);
  }

  return {
    kind: 'file',
    id: isAbsolute(loc) ? resolve(loc) : resolve(dirname(parent.id), loc),
  };
}

async function discardResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

async function fetchWithRedirects(source, runtime) {
  let current = new URL(source.id);
  const seen = new Set();
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  for (let redirects = 0; ; redirects += 1) {
    if (
      current.protocol !== 'https:'
      || current.origin !== source.origin
      || current.username
      || current.password
    ) {
      throw new Error(`Remote sitemap requests must use same-origin HTTPS: ${current.href}`);
    }
    if (seen.has(current.href)) {
      throw new Error(`Remote sitemap redirect loop detected at ${current.href}`);
    }
    seen.add(current.href);

    let response;
    try {
      response = await runtime.fetch(current.href, {
        headers: {
          accept: 'application/xml,text/xml,application/gzip,application/octet-stream;q=0.8',
          'accept-encoding': 'identity',
          'user-agent': `sitemap-cohort-auditor/${VERSION}`,
        },
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      throw new Error(`Could not fetch ${current.href}: ${error.message}`);
    }

    if (response.url) {
      let observed;
      try {
        observed = new URL(response.url);
        observed.hash = '';
      } catch {
        await discardResponseBody(response);
        throw new Error(`Fetch returned an invalid response URL for ${current.href}`);
      }
      if (observed.href !== current.href) {
        await discardResponseBody(response);
        throw new Error(`Fetch followed a redirect unexpectedly from ${current.href}`);
      }
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: current.href, signal };
    }

    const location = response.headers.get('location');
    await discardResponseBody(response);
    if (!location) {
      throw new Error(`Redirect from ${current.href} did not include a Location header`);
    }
    if (redirects >= runtime.maxRedirects) {
      throw new Error(
        `Remote sitemap exceeded the ${runtime.maxRedirects}-redirect limit at ${current.href}`,
      );
    }

    let redirected;
    try {
      redirected = new URL(location, current);
    } catch {
      throw new Error(`Invalid redirect Location from ${current.href}: ${location}`);
    }
    if (redirected.username || redirected.password) {
      throw new Error('Remote sitemap redirect URLs must not include credentials');
    }
    if (redirected.protocol !== 'https:' || redirected.origin !== source.origin) {
      throw new Error(`Remote sitemap redirects must use same-origin HTTPS: ${redirected.href}`);
    }
    redirected.hash = '';
    current = redirected;
  }
}

async function loadSource(source, runtime) {
  if (source.kind === 'file') {
    try {
      const highWaterMark = Math.min(64 * 1024, runtime.maxXmlBytes + 1);
      const stream = createReadStream(source.id, { highWaterMark });
      const xml = await decodeDocumentStream(stream, source.id, runtime.maxXmlBytes);
      return { xml, effectiveSource: source };
    } catch (error) {
      if (error instanceof DocumentLimitError || error.message.startsWith('Could not ')) throw error;
      throw new Error(`Could not read ${source.id}: ${error.message}`);
    }
  }

  const { response, finalUrl, signal } = await fetchWithRedirects(source, runtime);

  if (response.status !== 200) {
    await discardResponseBody(response);
    throw new Error(`Could not fetch ${finalUrl}: HTTP ${response.status}`);
  }

  const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    await discardResponseBody(response);
    throw new Error(`Unsupported Content-Encoding for ${finalUrl}: ${contentEncoding}`);
  }

  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength.trim())) {
    const length = Number(declaredLength);
    if (Number.isSafeInteger(length) && length > runtime.maxXmlBytes) {
      await discardResponseBody(response);
      throw new DocumentLimitError(
        `${finalUrl} declares a response larger than ${formatByteLimit(runtime.maxXmlBytes)}`,
      );
    }
  }

  const body = response.body ?? Readable.from([]);
  const xml = await decodeDocumentStream(body, finalUrl, runtime.maxXmlBytes, signal);
  return {
    xml,
    effectiveSource: { kind: 'https', id: finalUrl, origin: source.origin },
  };
}

function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function isIsoLastmod(value) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    return validCalendarDate(...dateOnly.slice(1).map(Number));
  }

  const dateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!dateTime) return false;

  const [year, month, day, hour, minute, second] = dateTime.slice(1, 7).map(Number);
  if (!validCalendarDate(year, month, day)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  if (dateTime[7] !== 'Z') {
    const offsetHour = Number(dateTime[8]);
    const offsetMinute = Number(dateTime[9]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }

  return true;
}

function createState(rootSource) {
  return {
    rootSource,
    visited: new Set(),
    documents: [],
    sitemapReferences: 0,
    alreadyVisitedReferences: [],
    urlOccurrences: new Map(),
    imageOccurrences: new Map(),
    invalidLastmods: [],
    lastmodCount: 0,
    fragments: [],
    invalidUrls: [],
    missingLocs: [],
  };
}

function recordLastmods(state, values, context) {
  for (const value of values) {
    state.lastmodCount += 1;
    if (!isIsoLastmod(value)) {
      state.invalidLastmods.push({ ...context, value });
    }
  }
}

function recordUrl(state, url, source) {
  const occurrences = state.urlOccurrences.get(url) ?? [];
  occurrences.push(source);
  state.urlOccurrences.set(url, occurrences);

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      state.invalidUrls.push({ source, url, reason: `unsupported URL scheme ${parsed.protocol}` });
      return;
    }
    if (parsed.hash) state.fragments.push({ source, url });
  } catch {
    state.invalidUrls.push({ source, url, reason: 'not an absolute URL' });
  }
}

function recordImage(state, url) {
  state.imageOccurrences.set(url, (state.imageOccurrences.get(url) ?? 0) + 1);
}

async function walk(source, state, runtime) {
  if (state.visited.has(source.id)) {
    state.alreadyVisitedReferences.push(source.id);
    return;
  }
  if (state.visited.size >= MAX_DOCUMENTS) {
    throw new Error(`Sitemap graph exceeds the ${MAX_DOCUMENTS.toLocaleString('en-US')} document safety limit`);
  }

  state.visited.add(source.id);
  const { xml, effectiveSource } = await loadSource(source, runtime);
  if (effectiveSource.id !== source.id) {
    if (state.visited.has(effectiveSource.id)) {
      state.alreadyVisitedReferences.push(effectiveSource.id);
      return;
    }
    state.visited.add(effectiveSource.id);
  }
  const kind = documentKind(xml);
  state.documents.push({ source: effectiveSource.id, type: kind });

  if (kind === 'sitemapindex') {
    const sitemapBlocks = extractBlocks(xml, 'sitemap');
    state.sitemapReferences += sitemapBlocks.length;

    for (const block of sitemapBlocks) {
      const loc = extractPrimaryLoc(block);
      recordLastmods(state, extractLastmods(block), {
        context: 'sitemap',
        source: effectiveSource.id,
        url: loc,
      });

      if (!loc) {
        state.missingLocs.push({ context: 'sitemap', source: effectiveSource.id });
        continue;
      }
      await walk(resolveChildSource(loc, effectiveSource), state, runtime);
    }
    return;
  }

  for (const block of extractBlocks(xml, 'url')) {
    const loc = extractPrimaryLoc(block);
    recordLastmods(state, extractLastmods(block), {
      context: 'url',
      source: effectiveSource.id,
      url: loc,
    });

    for (const imageLoc of extractImageLocs(block)) recordImage(state, imageLoc);

    if (!loc) {
      state.missingLocs.push({ context: 'url', source: effectiveSource.id });
      continue;
    }
    recordUrl(state, loc, effectiveSource.id);
  }
}

function countBy(values, keyFunction) {
  const counts = new Map();
  for (const value of values) {
    const key = keyFunction(value);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sortRecords(records, fields) {
  return [...records].sort((left, right) => {
    for (const field of fields) {
      const comparison = String(left[field] ?? '').localeCompare(String(right[field] ?? ''));
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

function finalize(state) {
  const uniqueUrls = [...state.urlOccurrences.keys()].sort();
  const validParsedUrls = uniqueUrls.flatMap((url) => {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol) ? [parsed] : [];
    } catch {
      return [];
    }
  });
  const duplicates = [...state.urlOccurrences.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([url, sources]) => ({
      url,
      count: sources.length,
      sources: [...new Set(sources)].sort(),
    }))
    .sort((left, right) => left.url.localeCompare(right.url));
  const urlEntries = [...state.urlOccurrences.values()]
    .reduce((total, sources) => total + sources.length, 0);
  const imageEntries = [...state.imageOccurrences.values()]
    .reduce((total, count) => total + count, 0);

  return {
    schemaVersion: 1,
    source: state.rootSource,
    summary: {
      documents: state.documents.length,
      sitemapReferences: state.sitemapReferences,
      urlEntries,
      uniqueUrls: uniqueUrls.length,
      duplicateUrls: duplicates.length,
      duplicateUrlEntries: urlEntries - uniqueUrls.length,
      imageEntries,
      uniqueImages: state.imageOccurrences.size,
      lastmodValues: state.lastmodCount,
      invalidLastmodValues: state.invalidLastmods.length,
      fragmentUrls: state.fragments.length,
      invalidUrls: state.invalidUrls.length,
      missingLocs: state.missingLocs.length,
    },
    hosts: countBy(validParsedUrls, (url) => url.host.toLowerCase()),
    schemes: countBy(validParsedUrls, (url) => url.protocol.slice(0, -1).toLowerCase()),
    duplicates,
    fragments: sortRecords(state.fragments, ['url', 'source']),
    invalidLastmods: sortRecords(state.invalidLastmods, ['value', 'url', 'source', 'context']),
    invalidUrls: sortRecords(state.invalidUrls, ['url', 'source']),
    missingLocs: sortRecords(state.missingLocs, ['context', 'source']),
    documents: sortRecords(state.documents, ['source', 'type']),
    skippedAlreadyVisited: [...new Set(state.alreadyVisitedReferences)].sort(),
    _uniqueUrls: uniqueUrls,
  };
}

async function auditSingle(input, runtime) {
  const source = normalizeInitialSource(input);
  const state = createState(source.id);
  await walk(source, state, runtime);
  return finalize(state);
}

export async function auditSitemap(input, options = {}) {
  const runtime = createRuntime(options);
  const current = await auditSingle(input, runtime);
  const currentUrls = current._uniqueUrls;
  delete current._uniqueUrls;

  if (options.compare) {
    const previous = await auditSingle(options.compare, runtime);
    const previousUrls = previous._uniqueUrls;
    const currentSet = new Set(currentUrls);
    const previousSet = new Set(previousUrls);
    const added = currentUrls.filter((url) => !previousSet.has(url));
    const removed = previousUrls.filter((url) => !currentSet.has(url));

    current.comparison = {
      source: previous.source,
      previousUniqueUrls: previousUrls.length,
      addedCount: added.length,
      removedCount: removed.length,
      added,
      removed,
    };
  }

  return current;
}

function formatNamedCounts(records) {
  return records.length > 0
    ? records.map(({ name, count }) => `${escapeTerminalText(name)}=${count}`).join(', ')
    : 'none';
}

export function formatTextReport(report) {
  const lines = [
    `Sitemap cohort audit: ${escapeTerminalText(report.source)}`,
    '',
    `Documents: ${report.summary.documents} (${report.summary.sitemapReferences} sitemap references)`,
    `URLs: ${report.summary.urlEntries} entries, ${report.summary.uniqueUrls} unique`,
    `Duplicates: ${report.summary.duplicateUrls} URLs (${report.summary.duplicateUrlEntries} extra entries)`,
    `Images: ${report.summary.imageEntries} entries, ${report.summary.uniqueImages} unique`,
    `Hosts: ${formatNamedCounts(report.hosts)}`,
    `Schemes: ${formatNamedCounts(report.schemes)}`,
    `Lastmod: ${report.summary.lastmodValues} values, ${report.summary.invalidLastmodValues} invalid/non-ISO`,
    `Fragments: ${report.summary.fragmentUrls}`,
    `Invalid URLs: ${report.summary.invalidUrls}`,
    `Missing <loc>: ${report.summary.missingLocs}`,
  ];

  if (report.duplicates.length > 0) {
    lines.push('', 'Duplicate URLs:');
    for (const duplicate of report.duplicates) {
      lines.push(`  ${duplicate.count}x ${escapeTerminalText(duplicate.url)}`);
    }
  }

  if (report.invalidLastmods.length > 0) {
    lines.push('', 'Invalid/non-ISO lastmod values:');
    for (const item of report.invalidLastmods) {
      const value = JSON.stringify(escapeTerminalText(item.value));
      const location = escapeTerminalText(item.url ?? item.source);
      lines.push(`  ${value} (${location})`);
    }
  }

  if (report.fragments.length > 0) {
    lines.push('', 'URLs with fragments:');
    for (const item of report.fragments) lines.push(`  ${escapeTerminalText(item.url)}`);
  }

  if (report.comparison) {
    lines.push(
      '',
      `Comparison: ${escapeTerminalText(report.comparison.source)}`,
      `Added: ${report.comparison.addedCount}`,
      ...report.comparison.added.map((url) => `  + ${escapeTerminalText(url)}`),
      `Removed: ${report.comparison.removedCount}`,
      ...report.comparison.removed.map((url) => `  - ${escapeTerminalText(url)}`),
    );
  }

  return `${lines.join('\n')}\n`;
}

export function sourceToFileUrl(path) {
  return pathToFileURL(resolve(path)).href;
}
