import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';

import { policyFindingMessage } from './policy.mjs';

export const VERSION = '0.2.2';

const MAX_DOCUMENTS = 10_000;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_XML_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class DocumentLimitError extends Error {}

export function incompleteInputReport(error) {
  const source = error?.inputSource === 'baseline' ? 'baseline' : 'current';
  const rule = /Could not read|unreadable/i.test(error?.message ?? '')
    ? 'input-unreadable' : 'input-invalid';
  return {
    schemaVersion: 2,
    tool: 'sitemap-cohort-auditor',
    status: 'incomplete',
    source,
    summary: { checked: 0, errors: 0, warnings: 1 },
    findings: [{
      rule,
      severity: 'warning',
      location: { file: source },
      message: 'The local input could not be evaluated.',
    }],
  };
}

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
  let cursor = 0;
  let scalar = '';

  while (cursor < value.length) {
    if (value[cursor] !== '<') {
      scalar += value[cursor];
      cursor += 1;
      continue;
    }

    if (!value.startsWith('<![CDATA[', cursor)) {
      throw new Error('Sitemap scalar values must not contain nested markup');
    }

    const end = value.indexOf(']]>', cursor + '<![CDATA['.length);
    if (end === -1) {
      throw new Error('Unterminated CDATA section in sitemap scalar value');
    }
    scalar += value.slice(cursor + '<![CDATA['.length, end);
    cursor = end + ']]>'.length;
  }

  return decodeXml(scalar).trim();
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
  const isXmlWhitespace = (character) => (
    character === ' ' || character === '\t' || character === '\n' || character === '\r'
  );
  const skipWhitespace = (start) => {
    let cursor = start;
    while (cursor < xml.length && isXmlWhitespace(xml[cursor])) cursor += 1;
    return cursor;
  };

  let cursor = xml.startsWith('\uFEFF') ? 1 : 0;
  cursor = skipWhitespace(cursor);

  if (xml.slice(cursor, cursor + 5).toLowerCase() === '<?xml') {
    if (!isXmlWhitespace(xml[cursor + 5])) {
      throw new Error('Malformed XML preamble: invalid XML declaration');
    }
    const declarationEnd = xml.indexOf('?>', cursor + 5);
    if (declarationEnd === -1) {
      throw new Error('Malformed XML preamble: unterminated XML declaration');
    }
    cursor = skipWhitespace(declarationEnd + 2);
  }

  while (xml.startsWith('<!--', cursor)) {
    const commentEnd = xml.indexOf('-->', cursor + 4);
    if (commentEnd === -1) {
      throw new Error('Malformed XML preamble: unterminated comment');
    }
    const comment = xml.slice(cursor + 4, commentEnd);
    if (comment.includes('--')) {
      throw new Error('Malformed XML preamble: comments cannot contain "--"');
    }
    cursor = skipWhitespace(commentEnd + 3);
  }

  const root = xml.slice(cursor);
  if (/^<(?:[A-Za-z_][\w.-]*:)?sitemapindex\b/i.test(root)) return 'sitemapindex';
  if (/^<(?:[A-Za-z_][\w.-]*:)?urlset\b/i.test(root)) return 'urlset';
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

/**
 * Order by UTF-16 code unit, deliberately not by locale.
 *
 * `localeCompare` depends on ICU data that varies between Node builds and
 * platforms. Sitemaps carry arbitrary URLs including non-ASCII paths, so
 * collation differences would let two correct machines emit differently
 * ordered cohorts -- and a release comparison diffing those reports would see
 * changes that are not there.
 */
function byCodeUnit(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function countBy(values, keyFunction) {
  const counts = new Map();
  for (const value of values) {
    const key = keyFunction(value);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => byCodeUnit(left.name, right.name));
}

function sortRecords(records, fields) {
  return [...records].sort((left, right) => {
    for (const field of fields) {
      const comparison = byCodeUnit(String(left[field] ?? ''), String(right[field] ?? ''));
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

/**
 * Stable fingerprint of a URL cohort.
 *
 * Computed over the sorted unique URLs, so the same cohort always produces the
 * same digest regardless of the order documents were traversed in. It lets an
 * earlier report prove whether the cohort changed even when that report did not
 * carry the URL list itself.
 */
export function cohortDigest(urls) {
  const hash = createHash('sha256');
  hash.update('sitemap-cohort-v2\0');
  for (const url of urls) {
    const bytes = Buffer.from(url, 'utf16le');
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function legacyCohortDigest(urls) {
  const hash = createHash('sha256');
  for (const url of urls) hash.update(url).update('\n');
  return `sha256:${hash.digest('hex')}`;
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
    .sort((left, right) => byCodeUnit(left.url, right.url));
  const urlEntries = [...state.urlOccurrences.values()]
    .reduce((total, sources) => total + sources.length, 0);
  const imageEntries = [...state.imageOccurrences.values()]
    .reduce((total, count) => total + count, 0);

  return {
    schemaVersion: 2,
    status: 'pass',
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
    cohort: {
      count: uniqueUrls.length,
      digestAlgorithm: 'sha256-framed-utf16le-v2',
      digest: cohortDigest(uniqueUrls),
    },
    _uniqueUrls: uniqueUrls,
  };
}

async function auditSingle(input, runtime) {
  const source = normalizeInitialSource(input);
  const state = createState(source.id);
  await walk(source, state, runtime);
  return finalize(state);
}

function hasDuplicateJsonKeys(raw) {
  const stack = [];
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '{') stack.push(new Set());
    else if (character === '[') stack.push(null);
    else if (character === '}' || character === ']') stack.pop();
    else if (character === '"') {
      const start = index;
      index += 1;
      while (index < raw.length) {
        if (raw[index] === '\\') index += 2;
        else if (raw[index] === '"') break;
        else index += 1;
      }
      let next = index + 1;
      while (/\s/.test(raw[next] ?? '')) next += 1;
      const keys = stack.at(-1);
      if (keys && raw[next] === ':') {
        const key = JSON.parse(raw.slice(start, index + 1));
        if (keys.has(key)) return true;
        keys.add(key);
      }
    }
  }
  return false;
}

/**
 * Read a comparison baseline from an earlier report emitted by this tool.
 *
 * Returns null when the file is not one, so the caller falls back to auditing
 * it as a sitemap. Only local files are considered: a report is a build
 * artifact, not something to fetch over the network.
 */
async function readReportBaseline(input) {
  if (/^https?:/i.test(input)) return null;
  const path = input.startsWith('file:') ? fileURLToPath(new URL(input)) : resolve(input);
  let raw;
  try {
    raw = await readFile(path);
  } catch {
    throw new Error('Comparison input is unreadable');
  }
  if (raw.length > MAX_REPORT_BYTES) {
    throw new Error(`Comparison report exceeds the ${MAX_REPORT_BYTES} byte limit`);
  }
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error('Comparison input is not valid UTF-8');
  }
  if (!content.trimStart().startsWith('{')) return null;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Comparison report is malformed JSON');
  }
  if (hasDuplicateJsonKeys(content)) throw new Error('Comparison report has a duplicate JSON key');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || ![1, 2].includes(parsed.schemaVersion)
    || !parsed.cohort || typeof parsed.cohort !== 'object' || Array.isArray(parsed.cohort)) {
    throw new Error('Comparison report has an unsupported structure');
  }

  const { count, digest, urls } = parsed.cohort;
  if (!Number.isSafeInteger(count) || count < 0
    || typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)
    || (parsed.schemaVersion === 2
      && parsed.cohort.digestAlgorithm !== 'sha256-framed-utf16le-v2')) {
    throw new Error('Comparison report has a malformed cohort section');
  }
  if (urls !== undefined) {
    if (!Array.isArray(urls) || urls.some((url) => typeof url !== 'string')) {
      throw new Error('Comparison report has a malformed cohort URL list');
    }
    const sorted = [...urls].sort(byCodeUnit);
    if (urls.length !== count || urls.some((url, index) => url !== sorted[index]
      || (index > 0 && url === sorted[index - 1]))) {
      throw new Error('Comparison report cohort count or unique sorted URL list is inconsistent');
    }
    const recordedDigest = parsed.schemaVersion === 1
      ? legacyCohortDigest(sorted) : cohortDigest(sorted);
    if (recordedDigest !== digest) {
      throw new Error('Comparison report cohort URLs do not match its recorded digest');
    }
    return { source: parsed.source ?? null, count, digest: cohortDigest(sorted), urls: sorted };
  }

  return {
    source: parsed.source ?? null,
    count,
    digest,
    urls: null,
    legacyDigestOnly: parsed.schemaVersion === 1,
  };
}

export async function auditSitemap(input, options = {}) {
  const runtime = createRuntime(options);
  let current;
  try {
    current = await auditSingle(input, runtime);
  } catch (error) {
    if (error instanceof Error) error.inputSource = 'current';
    throw error;
  }
  const currentUrls = current._uniqueUrls;
  delete current._uniqueUrls;

  if (options.withCohort) current.cohort.urls = currentUrls;

  if (options.compare) {
    let baseline;
    try {
      baseline = await readReportBaseline(options.compare)
        ?? await auditSingle(options.compare, runtime).then((previous) => ({
        source: previous.source,
        count: previous._uniqueUrls.length,
        digest: cohortDigest(previous._uniqueUrls),
        urls: previous._uniqueUrls,
        }));
    } catch (error) {
      if (error instanceof Error) error.inputSource = 'baseline';
      throw error;
    }

    current.comparison = {
      source: baseline.source,
      baselineKind: baseline.urls === null ? 'report' : 'sitemap-or-report',
      previousUniqueUrls: baseline.count,
      previousCohortDigest: baseline.digest,
    };

    if (baseline.legacyDigestOnly) {
      current.status = 'incomplete';
      current.comparison.evidence = 'legacy-digest-only';
      current.comparison.status = 'incomplete';
      current.comparison.cohortChanged = null;
      current.comparison.note = 'The legacy digest cannot be compared safely with the framed digest; added and removed URLs are unknown.';
    } else if (baseline.urls === null) {
      // The earlier report recorded only a digest, so which URLs moved is not
      // recoverable. Say that plainly instead of reporting zero changes.
      current.comparison.evidence = 'digest-only';
      current.comparison.cohortChanged = baseline.digest !== current.cohort.digest;
      current.comparison.note =
        'The comparison report did not include its cohort URL list, so added and removed URLs are unknown. Re-run the earlier audit with --with-cohort to record them.';
    } else {
      const currentSet = new Set(currentUrls);
      const previousSet = new Set(baseline.urls);
      const added = currentUrls.filter((url) => !previousSet.has(url));
      const removed = baseline.urls.filter((url) => !currentSet.has(url));

      current.comparison.evidence = 'urls';
      current.comparison.cohortChanged = baseline.digest !== current.cohort.digest;
      current.comparison.addedCount = added.length;
      current.comparison.removedCount = removed.length;
      current.comparison.added = added;
      current.comparison.removed = removed;
    }
  }

  return current;
}

function formatNamedCounts(records) {
  return records.length > 0
    ? records.map(({ name, count }) => `${escapeTerminalText(name)}=${count}`).join(', ')
    : 'none';
}

export function formatTextReport(report) {
  if (report.status === 'incomplete' && Array.isArray(report.findings)) {
    return `Sitemap cohort audit: ${report.source}\nStatus: incomplete\n${report.findings[0].rule}: The local input could not be evaluated.\n`;
  }
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
    lines.push('', `Comparison: ${escapeTerminalText(report.comparison.source)}`);
    if (report.comparison.evidence === 'digest-only'
      || report.comparison.evidence === 'legacy-digest-only') {
      lines.push('Added: unknown', 'Removed: unknown');
    } else {
      lines.push(
        `Added: ${report.comparison.addedCount}`,
        ...report.comparison.added.map((url) => `  + ${escapeTerminalText(url)}`),
        `Removed: ${report.comparison.removedCount}`,
        ...report.comparison.removed.map((url) => `  - ${escapeTerminalText(url)}`),
      );
    }
  }

  if (report.policy) {
    lines.push(
      '',
      `Policy: ${report.policy.status.toUpperCase()} (${escapeTerminalText(report.policy.source)})`,
    );
    if (report.policy.incompleteRules.length > 0) {
      lines.push(`  Unevaluated rules: ${report.policy.incompleteRules.join(', ')}`);
    }
    for (const finding of report.policy.findings) {
      lines.push(`  ${escapeTerminalText(finding.code)}: ${escapeTerminalText(policyFindingMessage(finding))}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function sourceToFileUrl(path) {
  return pathToFileURL(resolve(path)).href;
}
