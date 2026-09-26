import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { performance } from 'node:perf_hooks';

import { attachAuditEvidence, policyFindingMessage } from './policy.mjs';

export const VERSION = '0.2.2';

const MAX_DOCUMENTS = 10_000;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_XML_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const AUDIT_OPTION_KEYS = new Set([
  'root', 'compare', 'withCohort', 'maxXmlBytes', 'timeoutMs', 'now',
]);

class DocumentLimitError extends Error {}
class DeadlineError extends Error {
  constructor(ruleId) {
    super(ruleId);
    this.ruleId = ruleId;
  }
}

export function incompleteInputReport(error) {
  const source = error?.inputSource === 'baseline' ? 'baseline' : 'current';
  const rule = /Could not read|unreadable/i.test(error?.message ?? '')
    ? 'input-unreadable' : 'input-invalid';
  if (source === 'baseline' && error?.currentReport) {
    const current = error.currentReport;
    current.status = 'incomplete';
    current.comparison = {
      source: 'baseline', status: 'incomplete', evidence: 'unavailable',
      note: 'The comparison input could not be evaluated.',
    };
    delete current._uniqueUrls;
    const report = completeReportEnvelope(projectReport(current, null));
    report.findings.push({
      rule, ruleId: rule, severity: 'warning',
      location: { file: 'baseline', pointer: '/' },
      message: 'The local comparison input could not be evaluated.',
    });
    report.findings.sort(compareFinding);
    report.summary.warnings += 1;
    return report;
  }
  return {
    schemaVersion: 2,
    tool: 'sitemap-cohort-auditor',
    status: 'incomplete',
    source,
    summary: { checked: 0, errors: 0, warnings: 1 },
    findings: [{
      rule,
      ruleId: rule,
      severity: 'warning',
      location: { file: source, pointer: '/' },
      message: 'The local input could not be evaluated.',
    }],
  };
}

const QUALITY_FINDINGS = Object.freeze([
  ['duplicates', 'duplicate-url', 'A URL has multiple declarations.'],
  ['fragments', 'url-fragment', 'A URL contains a fragment.'],
  ['invalidLastmods', 'lastmod-invalid', 'A lastmod value is not valid ISO date evidence.'],
  ['invalidUrls', 'invalid-url', 'A URL declaration cannot be evaluated as an HTTP(S) URL.'],
  ['missingLocs', 'loc-missing', 'A sitemap entry has no loc value.'],
]);

function compareFinding(left, right) {
  for (const field of [
    [left.location.file, right.location.file],
    [left.location.pointer, right.location.pointer],
    [left.ruleId, right.ruleId],
  ]) {
    const order = byCodeUnit(...field);
    if (order !== 0) return order;
  }
  return 0;
}

/** Add the house envelope without changing the legacy audit evidence fields. */
export function completeReportEnvelope(report) {
  if (!Array.isArray(report.documents)) return report;
  const findings = [];
  for (const [field, ruleId, message] of QUALITY_FINDINGS) {
    for (const [index] of (report[field] ?? []).entries()) {
      findings.push({
        ruleId,
        severity: 'warning',
        location: { file: 'current', pointer: `/${field}/${index}` },
        message,
      });
    }
  }
  if (report.comparison?.status === 'incomplete') {
    findings.push({
      ruleId: 'cohort-movement-unknown', severity: 'warning',
      location: { file: 'baseline', pointer: '/comparison' },
      message: 'The baseline cannot establish exact added and removed URLs.',
    });
  }
  for (const [index] of (report.policy?.incompleteRules ?? []).entries()) {
    findings.push({
      ruleId: 'policy-evidence-incomplete', severity: 'warning',
      location: { file: 'policy', pointer: `/incompleteRules/${index}` },
      message: 'A policy rule cannot be evaluated from the available evidence.',
    });
  }
  for (const [index, finding] of (report.policy?.findings ?? []).entries()) {
    findings.push({
      ruleId: `policy-${finding.code.toLowerCase().replaceAll('_', '-')}`,
      severity: 'error',
      location: { file: 'policy', pointer: `/findings/${index}` },
      message: 'A configured policy rule is violated by known evidence.',
    });
  }
  if (report.deadline) {
    findings.push({
      ruleId: report.deadline.ruleId, severity: 'warning',
      location: { file: report.deadline.source, pointer: '/' },
      message: report.deadline.ruleId === 'clock-invalid'
        ? 'The injected monotone clock could not be evaluated.'
        : 'The bounded analysis time was exhausted before completion.',
    });
  }
  findings.sort(compareFinding);
  report.tool = 'sitemap-cohort-auditor';
  report.findings = findings;
  report.summary.checked = report.documents.length;
  report.summary.errors = findings.filter(({ severity }) => severity === 'error').length;
  report.summary.warnings = findings.filter(({ severity }) => severity === 'warning').length;
  report.status = report.comparison?.status === 'incomplete'
    || report.policy?.status === 'incomplete'
    || report.status === 'incomplete'
    ? 'incomplete' : report.summary.errors > 0 ? 'fail' : 'pass';
  return report;
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

function validateAuditOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new Error('Audit options must be a plain object');
  }
  if (Object.hasOwn(options, 'fetch') || Object.hasOwn(options, 'maxRedirects')) {
    throw new Error('The fetch option is unsupported: this tool audits local exports offline');
  }
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !AUDIT_OPTION_KEYS.has(key)) {
      throw new Error('Unsupported audit option');
    }
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')) {
      throw new Error('Audit options must be data properties');
    }
  }
  for (const name of ['root', 'compare']) {
    if (Object.hasOwn(options, name)
      && (typeof options[name] !== 'string' || options[name].length === 0)) {
      throw new Error(`${name} must be a non-empty local path string`);
    }
  }
  if (Object.hasOwn(options, 'withCohort') && typeof options.withCohort !== 'boolean') {
    throw new Error('withCohort must be a boolean');
  }
  if (Object.hasOwn(options, 'now') && typeof options.now !== 'function') {
    throw new Error('now must be a monotone clock function');
  }
  for (const name of ['maxXmlBytes', 'timeoutMs']) {
    if (Object.hasOwn(options, name) && options[name] === undefined) {
      throw new Error(`${name} must be a configured integer`);
    }
  }
}

function createRuntime(options) {
  validateAuditOptions(options);
  const timeoutMs = validatedLimit(options.timeoutMs, MAX_TIMEOUT_MS, 'timeoutMs', 0);
  const now = options.now ?? performance.now.bind(performance);
  let start;
  let previous;
  const runtime = {
    maxXmlBytes: validatedLimit(options.maxXmlBytes, MAX_XML_BYTES, 'maxXmlBytes'),
    timeoutMs: options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs,
    phase: 'current',
    state: null,
    currentReport: null,
    tick() {
      let time;
      try { time = now(); } catch { throw new DeadlineError('clock-invalid'); }
      if (typeof time !== 'number' || !Number.isFinite(time)
        || (previous !== undefined && time < previous)) {
        throw new DeadlineError('clock-invalid');
      }
      if (start === undefined) start = time;
      previous = time;
      if (time - start > runtime.timeoutMs) throw new DeadlineError('timeout-exceeded');
    },
  };
  return runtime;
}

function isWithinRoot(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function localRoot(input, options) {
  const source = normalizeInitialSource(input);
  const rootPath = options.root === undefined ? dirname(source.id) : resolve(options.root);
  const root = await realpath(rootPath);
  if (!(await stat(root)).isDirectory()) throw new Error('Local root must be a directory');
  return root;
}

async function confinedSource(source, runtime) {
  const lexical = resolve(source.id);
  let real;
  try {
    real = await realpath(lexical);
  } catch {
    throw new Error(`Could not read ${lexical}: source is unavailable`);
  }
  if (!isWithinRoot(real, runtime.root)) {
    throw new Error('Local sitemap path resolves outside the declared root');
  }
  return { kind: 'file', id: real };
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

function cleanText(value, runtime) {
  let cursor = 0;
  let scalar = '';

  while (cursor < value.length) {
    if ((cursor & 1023) === 0) runtime.tick();
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
    runtime.tick();
  }

  runtime.tick();
  const decoded = decodeXml(scalar).trim();
  runtime.tick();
  return decoded;
}

function* extractBlocks(xml, localName, runtime) {
  const expression = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}\\s*>`,
    'gi',
  );
  runtime.tick();
  for (const match of xml.matchAll(expression)) {
    runtime.tick();
    yield match[1];
  }
  runtime.tick();
}

function extractTagMatches(xml, localName, runtime) {
  const expression = new RegExp(
    `<((?:[A-Za-z_][\\w.-]*:)?${localName})\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}\\s*>`,
    'gi',
  );
  const matches = [];
  runtime.tick();
  for (const match of xml.matchAll(expression)) {
    runtime.tick();
    matches.push({
      qualifiedName: match[1].toLowerCase(),
      value: cleanText(match[2], runtime),
    });
  }
  runtime.tick();
  return matches;
}

function extractPrimaryLoc(block, runtime) {
  const matches = extractTagMatches(block, 'loc', runtime);
  const primary = matches.find(({ qualifiedName }) => qualifiedName !== 'image:loc');
  return primary?.value ?? null;
}

function extractImageLocs(block, runtime) {
  return extractTagMatches(block, 'loc', runtime)
    .filter(({ qualifiedName }) => qualifiedName === 'image:loc')
    .map(({ value }) => value);
}

function extractLastmods(block, runtime) {
  return extractTagMatches(block, 'lastmod', runtime).map(({ value }) => value);
}

function documentKind(xml, runtime) {
  runtime.tick();
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
  runtime.tick();
  if (/^<(?:[A-Za-z_][\w.-]*:)?sitemapindex\b/i.test(root)) return 'sitemapindex';
  if (/^<(?:[A-Za-z_][\w.-]*:)?urlset\b/i.test(root)) return 'urlset';
  throw new Error('XML root must be <urlset> or <sitemapindex>');
}

function isGzip(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

async function* limitedChunks(iterable, maximumBytes, source, runtime) {
  let total = 0;

  for await (const value of iterable) {
    runtime.tick();
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

async function collectDecodedStream(readable, maximumBytes, source, compressed, runtime) {
  const chunks = [];
  let total = 0;
  const collector = new Writable({
    write(value, _encoding, callback) {
      try { runtime.tick(); } catch (error) { callback(error); return; }
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
  try {
    if (decompressor) await pipeline(readable, decompressor, collector);
    else await pipeline(readable, collector);
  } catch (error) {
    if (error instanceof DocumentLimitError || error instanceof DeadlineError) throw error;
    if (compressed) {
      throw new Error(`Could not decompress ${source}: ${error.message}`);
    }
    throw error;
  }

  return Buffer.concat(chunks, total);
}

async function decodeDocumentStream(iterable, source, maximumBytes, runtime) {
  const limited = limitedChunks(iterable, maximumBytes, source, runtime);
  const { prefix, readable } = await peekStream(limited, 2);
  const compressed = isGzip(prefix);
  const content = await collectDecodedStream(readable, maximumBytes, source, compressed, runtime);

  try {
    runtime.tick();
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(content);
    runtime.tick();
    return decoded;
  } catch (error) {
    if (error instanceof DeadlineError) throw error;
    throw new Error(`Could not decode ${source} as UTF-8: ${error.message}`);
  }
}

function normalizeInitialSource(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('A local export path is required');
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    parsed = null;
  }

  if (parsed?.protocol === 'file:') {
    const path = resolve(fileURLToPath(parsed));
    return { kind: 'file', id: path };
  }
  if (parsed) {
    throw new Error('Only local export paths are supported offline');
  }

  return { kind: 'file', id: resolve(input) };
}

function resolveChildSource(loc, parent) {
  let parsed;
  try {
    parsed = new URL(loc);
  } catch {
    parsed = null;
  }

  if (parsed?.protocol === 'https:') {
    throw new Error('Local sitemap indexes may reference only local child files');
  }
  if (parsed?.protocol === 'file:') {
    return { kind: 'file', id: resolve(fileURLToPath(parsed)) };
  }
  if (parsed) {
    throw new Error('Local sitemap indexes may reference only local child files');
  }

  return {
    kind: 'file',
    id: isAbsolute(loc) ? resolve(loc) : resolve(dirname(parent.id), loc),
  };
}


async function loadSource(source, runtime) {
  try {
    const highWaterMark = Math.min(64 * 1024, runtime.maxXmlBytes + 1);
    const stream = createReadStream(source.id, { highWaterMark });
    const xml = await decodeDocumentStream(stream, source.id, runtime.maxXmlBytes, runtime);
    return { xml, effectiveSource: source };
  } catch (error) {
    if (error instanceof DocumentLimitError || error instanceof DeadlineError
      || error.message.startsWith('Could not ')) throw error;
    throw new Error(`Could not read ${source.id}: ${error.message}`);
  }
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
  runtime.tick();
  source = await confinedSource(source, runtime);
  runtime.tick();
  if (state.visited.has(source.id)) {
    state.alreadyVisitedReferences.push(source.id);
    return;
  }
  if (state.visited.size >= MAX_DOCUMENTS) {
    throw new Error(`Sitemap graph exceeds the ${MAX_DOCUMENTS.toLocaleString('en-US')} document safety limit`);
  }

  state.visited.add(source.id);
  const { xml, effectiveSource } = await loadSource(source, runtime);
  runtime.tick();
  if (effectiveSource.id !== source.id) {
    if (state.visited.has(effectiveSource.id)) {
      state.alreadyVisitedReferences.push(effectiveSource.id);
      return;
    }
    state.visited.add(effectiveSource.id);
  }
  const kind = documentKind(xml, runtime);

  if (kind === 'sitemapindex') {
    const children = [];

    for (const block of extractBlocks(xml, 'sitemap', runtime)) {
      runtime.tick();
      state.sitemapReferences += 1;
      const loc = extractPrimaryLoc(block, runtime);
      recordLastmods(state, extractLastmods(block, runtime), {
        context: 'sitemap',
        source: effectiveSource.id,
        url: loc,
      });

      if (!loc) {
        state.missingLocs.push({ context: 'sitemap', source: effectiveSource.id });
        continue;
      }
      children.push(resolveChildSource(loc, effectiveSource));
    }
    runtime.tick();
    state.documents.push({ source: effectiveSource.id, type: kind });
    for (const child of children) await walk(child, state, runtime);
    return;
  }

  for (const block of extractBlocks(xml, 'url', runtime)) {
    runtime.tick();
    const loc = extractPrimaryLoc(block, runtime);
    recordLastmods(state, extractLastmods(block, runtime), {
      context: 'url',
      source: effectiveSource.id,
      url: loc,
    });

    for (const imageLoc of extractImageLocs(block, runtime)) recordImage(state, imageLoc);

    if (!loc) {
      state.missingLocs.push({ context: 'url', source: effectiveSource.id });
      continue;
    }
    recordUrl(state, loc, effectiveSource.id);
  }
  runtime.tick();
  state.documents.push({ source: effectiveSource.id, type: kind });
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
  const hostOrder = [];
  for (const url of state.urlOccurrences.keys()) {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:'].includes(parsed.protocol)
        && !hostOrder.includes(parsed.host.toLowerCase())) {
        hostOrder.push(parsed.host.toLowerCase());
      }
    } catch {
      // Invalid URL evidence remains visible as an incomplete allowlist index.
    }
  }
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
    }));
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
    fragments: [...state.fragments],
    invalidLastmods: [...state.invalidLastmods],
    invalidUrls: [...state.invalidUrls],
    missingLocs: [...state.missingLocs],
    documents: [...state.documents],
    skippedAlreadyVisited: [...new Set(state.alreadyVisitedReferences)],
    cohort: {
      count: uniqueUrls.length,
      digestAlgorithm: 'sha256-framed-utf16le-v2',
      digest: cohortDigest(uniqueUrls),
    },
    _uniqueUrls: uniqueUrls,
    _urlOrder: [...state.urlOccurrences.keys()],
    _hostOrder: hostOrder,
  };
}

function projectReport(report, baselineUrls) {
  const documents = new Map(report.documents.map((item, index) => [
    item.source, `document-${index + 1}`,
  ]));
  const urls = new Map(report._urlOrder.map((url, index) => [url, index + 1]));
  const previous = new Map((baselineUrls ?? []).map((url, index) => [url, index + 1]));
  const source = (raw) => documents.get(raw) ?? 'document-unknown';
  const rawHosts = report.hosts.map((item) => ({
    ...item,
    ordinal: report._hostOrder.indexOf(item.name) + 1,
  }));
  attachAuditEvidence(report, { hosts: rawHosts });

  report.source = 'current';
  report.hosts = rawHosts
    .sort((left, right) => left.ordinal - right.ordinal)
    .map(({ ordinal, count }) => ({ name: `host-${ordinal}`, count }));
  report.duplicates = report.duplicates.map((item) => ({
    urlOrdinal: urls.get(item.url),
    count: item.count,
    sources: item.sources.map(source),
  }));
  report.fragments = report.fragments.map((item) => ({
    urlOrdinal: urls.get(item.url),
    source: source(item.source),
  }));
  report.invalidLastmods = report.invalidLastmods.map((item) => ({
    context: item.context,
    source: source(item.source),
    ...(urls.has(item.url) ? { urlOrdinal: urls.get(item.url) } : {}),
  }));
  report.invalidUrls = report.invalidUrls.map((item) => ({
    urlOrdinal: urls.get(item.url),
    source: source(item.source),
    reason: item.reason.startsWith('unsupported') ? 'unsupported URL scheme' : item.reason,
  }));
  report.missingLocs = report.missingLocs.map((item) => ({
    context: item.context,
    source: source(item.source),
  }));
  report.documents = report.documents.map((item) => ({
    source: source(item.source),
    type: item.type,
  }));
  report.skippedAlreadyVisited = [...new Set(report.skippedAlreadyVisited.map(source))];
  if (report.comparison) {
    report.comparison.source = 'baseline';
    if (report.comparison.evidence === 'urls') {
      report.comparison.added = report.comparison.added
        .map((url) => ({ urlOrdinal: urls.get(url) }))
        .sort((left, right) => left.urlOrdinal - right.urlOrdinal);
      report.comparison.removed = report.comparison.removed
        .map((url) => ({ baselineUrlOrdinal: previous.get(url) }))
        .sort((left, right) => left.baselineUrlOrdinal - right.baselineUrlOrdinal);
    }
  }
  delete report._urlOrder;
  delete report._hostOrder;
  return report;
}

async function auditSingle(input, runtime) {
  const source = normalizeInitialSource(input);
  const state = createState(source.id);
  runtime.state = state;
  await walk(source, state, runtime);
  runtime.tick();
  return finalize(state);
}

function partialDeadlineReport(runtime, error) {
  const source = runtime.phase === 'baseline' ? 'baseline' : 'current';
  const deadline = { ruleId: error.ruleId, source };
  if (runtime.currentReport) {
    const report = runtime.currentReport;
    report.status = 'incomplete';
    if (runtime.phase === 'baseline') {
      report.comparison = {
        source: 'baseline', status: 'incomplete', evidence: 'timeout',
        note: 'The comparison was not completed within the analysis deadline.',
      };
    }
    delete report._uniqueUrls;
    report.deadline = deadline;
    return completeReportEnvelope(projectReport(report, null));
  }

  const state = runtime.state;
  const documents = state?.documents ?? [];
  const sourceLabels = new Map(documents.map((item, index) =>
    [item.source, `document-${index + 1}`]));
  const known = (items) => (items ?? [])
    .map((item) => ({ source: sourceLabels.get(item.source) ?? 'document-in-progress' }));
  const duplicates = [];
  for (const sources of state?.urlOccurrences.values() ?? []) {
    if (sources.length > 1) duplicates.push({ count: sources.length });
  }
  return completeReportEnvelope({
    schemaVersion: 2,
    status: 'incomplete',
    source: 'current',
    summary: { documents: documents.length },
    documents: documents.map((item) => ({
      source: sourceLabels.get(item.source), type: item.type,
    })),
    duplicates,
    fragments: known(state?.fragments),
    invalidLastmods: known(state?.invalidLastmods),
    invalidUrls: known(state?.invalidUrls),
    missingLocs: known(state?.missingLocs),
    deadline,
  });
}

function hasDuplicateJsonKeys(raw, runtime) {
  const stack = [];
  let nextTick = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (index >= nextTick) {
      runtime.tick();
      nextTick = index + 1024;
    }
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

/** Collect no more than the allowed report bytes, stopping the source at N+1. */
export async function readBoundedReportBytes(stream, maxBytes = MAX_REPORT_BYTES, tick = () => {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    tick();
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new DocumentLimitError(`Comparison report exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

/**
 * Read a comparison baseline from an earlier report emitted by this tool.
 *
 * Returns null when the file is not one, so the caller falls back to auditing
 * it as a sitemap. Only local files are considered: a report is a build
 * artifact, not something to fetch over the network.
 */
async function readReportBaseline(input, runtime) {
  runtime.tick();
  const path = (await confinedSource(normalizeInitialSource(input), runtime)).id;
  runtime.tick();
  let raw;
  try {
    raw = await readBoundedReportBytes(
      createReadStream(path, { highWaterMark: 64 * 1024 }),
      MAX_REPORT_BYTES,
      () => runtime.tick(),
    );
  } catch (error) {
    if (error instanceof DocumentLimitError || error instanceof DeadlineError) throw error;
    throw new Error('Comparison input is unreadable');
  }
  runtime.tick();
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error('Comparison input is not valid UTF-8');
  }
  runtime.tick();
  if (!content.trimStart().startsWith('{')) return null;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Comparison report is malformed JSON');
  }
  runtime.tick();
  if (hasDuplicateJsonKeys(content, runtime)) throw new Error('Comparison report has a duplicate JSON key');
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
    runtime.tick();
    if (urls.length !== count || urls.some((url, index) => url !== sorted[index]
      || (index > 0 && url === sorted[index - 1]))) {
      throw new Error('Comparison report cohort count or unique sorted URL list is inconsistent');
    }
    const recordedDigest = parsed.schemaVersion === 1
      ? legacyCohortDigest(sorted) : cohortDigest(sorted);
    runtime.tick();
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
  try {
    runtime.tick();
    runtime.root = await localRoot(input, options);
    runtime.tick();
    let current;
    try {
      current = await auditSingle(input, runtime);
    } catch (error) {
      if (error instanceof Error) error.inputSource = 'current';
      throw error;
    }
    const currentUrls = current._uniqueUrls;
    delete current._uniqueUrls;
    runtime.currentReport = current;

    if (options.withCohort) current.cohort.urls = currentUrls;

    if (options.compare) {
      runtime.phase = 'baseline';
      runtime.tick();
      let baseline;
      try {
        baseline = await readReportBaseline(options.compare, runtime)
          ?? await auditSingle(options.compare, runtime).then((previous) => ({
            source: previous.source,
            count: previous._uniqueUrls.length,
            digest: cohortDigest(previous._uniqueUrls),
            urls: previous._uniqueUrls,
          }));
      } catch (error) {
        if (error instanceof Error) {
          error.inputSource = 'baseline';
          error.currentReport = current;
        }
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
        current.status = 'incomplete';
        current.comparison.evidence = 'digest-only';
        current.comparison.status = 'incomplete';
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
      current._baselineUrls = baseline.urls;
    }
    runtime.tick();
    const baselineUrls = current._baselineUrls;
    delete current._baselineUrls;
    return completeReportEnvelope(projectReport(current, baselineUrls));
  } catch (error) {
    if (error instanceof DeadlineError) return partialDeadlineReport(runtime, error);
    throw error;
  }
}

function formatNamedCounts(records) {
  return records.length > 0
    ? records.map(({ name, count }) => `${escapeTerminalText(name)}=${count}`).join(', ')
    : 'none';
}

export function formatTextReport(report) {
  if (report.status === 'incomplete' && !Array.isArray(report.documents)) {
    return `Sitemap cohort audit: ${report.source}\nStatus: incomplete\n${report.findings[0].rule}: The local input could not be evaluated.\n`;
  }
  if (report.deadline && !report.cohort) {
    const known = report.findings
      .filter(({ ruleId }) => ruleId !== 'timeout-exceeded' && ruleId !== 'clock-invalid')
      .map(({ ruleId, location }) =>
        `  ${ruleId} at ${location.file}${location.pointer}`);
    return [
      'Sitemap cohort audit: current', 'Status: incomplete',
      `Checked documents: ${report.summary.checked}`,
      `${report.deadline.ruleId}: Analysis did not complete.`,
      ...(known.length > 0 ? ['Known observations:', ...known] : []),
    ].join('\n') + '\n';
  }
  const lines = [
    `Sitemap cohort audit: ${escapeTerminalText(report.source)}`,
    `Status: ${report.status ?? 'unknown'}`,
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
      lines.push(`  URL #${duplicate.urlOrdinal}: ${duplicate.count} declarations`);
    }
  }

  if (report.invalidLastmods.length > 0) {
    lines.push('', 'Invalid/non-ISO lastmod values:');
    for (const item of report.invalidLastmods) {
      lines.push(`  ${item.context} in ${escapeTerminalText(item.source)}`);
    }
  }

  if (report.fragments.length > 0) {
    lines.push('', 'URLs with fragments:');
    for (const item of report.fragments) lines.push(`  URL #${item.urlOrdinal}`);
  }

  if (report.comparison) {
    lines.push('', `Comparison: ${escapeTerminalText(report.comparison.source)}`);
    if (report.comparison.status === 'incomplete') {
      lines.push('Added: unknown', 'Removed: unknown');
    } else {
      lines.push(
        `Added: ${report.comparison.addedCount}`,
        ...report.comparison.added.map((item) => `  + current URL #${item.urlOrdinal}`),
        `Removed: ${report.comparison.removedCount}`,
        ...report.comparison.removed.map((item) => `  - baseline URL #${item.baselineUrlOrdinal}`),
      );
    }
  }

  if (report.deadline) {
    lines.push('', `${report.deadline.ruleId}: Analysis did not complete.`);
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
