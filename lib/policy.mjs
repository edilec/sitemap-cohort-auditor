import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';

export const POLICY_SCHEMA_VERSION = 1;
const auditEvidence = new WeakMap();

export function attachAuditEvidence(report, evidence) {
  auditEvidence.set(report, evidence);
}

const MAX_POLICY_BYTES = 64 * 1024;
const SAFE_READ_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ELOOP', 'EMFILE', 'ENFILE',
]);
const POLICY_KEYS = new Set([
  'schemaVersion',
  'allowedHosts',
  'allowedSchemes',
  'minUniqueUrls',
  'minUniqueImages',
  'maxDuplicateUrls',
  'maxDuplicateUrlEntries',
  'maxInvalidLastmodValues',
  'maxFragmentUrls',
  'maxInvalidUrls',
  'maxMissingLocs',
  'maxRemovedUrls',
]);
const INTEGER_RULES = new Set([
  'minUniqueUrls',
  'minUniqueImages',
  'maxDuplicateUrls',
  'maxDuplicateUrlEntries',
  'maxInvalidLastmodValues',
  'maxFragmentUrls',
  'maxInvalidUrls',
  'maxMissingLocs',
  'maxRemovedUrls',
]);
const SCHEMES = new Set(['http', 'https']);
const FINDING_LABELS = Object.freeze({
  MAX_DUPLICATE_URL_ENTRIES: 'Extra duplicate URL entries',
  MAX_DUPLICATE_URLS: 'Duplicate URLs',
  MAX_FRAGMENT_URLS: 'Fragment URLs',
  MAX_INVALID_LASTMOD_VALUES: 'Invalid lastmod values',
  MAX_INVALID_URLS: 'Invalid URLs',
  MAX_MISSING_LOCS: 'Missing loc values',
  MAX_REMOVED_URLS: 'Removed URLs',
  MIN_UNIQUE_IMAGES: 'Unique images',
  MIN_UNIQUE_URLS: 'Unique URLs',
});

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDataProperty(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`Policy property "${key}" must be a data property`);
  }
  return descriptor.value;
}

function normalizedStringArray(value, key, normalize, validate) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Policy property "${key}" must be a non-empty array of strings`);
  }

  const normalized = value.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item !== item.trim()) {
      throw new Error(`Policy property "${key}" must contain non-empty trimmed strings`);
    }
    const result = normalize(item);
    if (!validate(result)) {
      throw new Error(`Policy property "${key}" contains an unsupported value`);
    }
    return result;
  });

  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) {
    throw new Error(`Policy property "${key}" must not contain duplicate values`);
  }
  return Object.freeze(unique);
}

function normalizeHost(value) {
  if (/[/@?#\s]/u.test(value)) return null;
  try {
    const parsed = new URL(`https://${value}/`);
    return parsed.host === value.toLowerCase() ? parsed.host : null;
  } catch {
    return null;
  }
}

export function parsePolicyObject(value) {
  if (!isPlainRecord(value)) {
    throw new Error('Policy must be a JSON object');
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new Error('Policy must not contain symbol properties');
  }
  const unknown = ownKeys.filter((key) => !POLICY_KEYS.has(key)).sort();
  if (unknown.length > 0) {
    throw new Error(`Unknown policy ${unknown.length === 1 ? 'property' : 'properties'} (${unknown.length} unrecognized key${unknown.length === 1 ? '' : 's'})`);
  }
  if (!ownKeys.includes('schemaVersion')) {
    throw new Error('Policy property "schemaVersion" is required');
  }
  if (readDataProperty(value, 'schemaVersion') !== POLICY_SCHEMA_VERSION) {
    throw new Error(`Policy schemaVersion must be ${POLICY_SCHEMA_VERSION}`);
  }

  const policy = Object.create(null);
  policy.schemaVersion = POLICY_SCHEMA_VERSION;

  for (const key of ownKeys.sort()) {
    if (key === 'schemaVersion') continue;
    const rule = readDataProperty(value, key);

    if (INTEGER_RULES.has(key)) {
      if (!Number.isSafeInteger(rule) || rule < 0) {
        throw new Error(`Policy property "${key}" must be a non-negative safe integer`);
      }
      policy[key] = rule;
      continue;
    }

    if (key === 'allowedHosts') {
      policy.allowedHosts = normalizedStringArray(
        rule,
        key,
        (item) => normalizeHost(item),
        (item) => typeof item === 'string' && item.length > 0,
      );
      continue;
    }

    if (key === 'allowedSchemes') {
      policy.allowedSchemes = normalizedStringArray(
        rule,
        key,
        (item) => item.toLowerCase(),
        (item) => SCHEMES.has(item),
      );
    }
  }

  if (ownKeys.length === 1) {
    throw new Error('Policy must define at least one rule');
  }

  return Object.freeze(policy);
}

async function readBoundedUtf8File(path, maximumBytes = MAX_POLICY_BYTES) {
  const chunks = [];
  let total = 0;

  try {
    for await (const value of createReadStream(path, { highWaterMark: Math.min(16 * 1024, maximumBytes + 1) })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.length;
      if (total > maximumBytes) {
        throw new Error(`Policy file exceeds the ${maximumBytes.toLocaleString('en-US')} byte limit`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.message?.startsWith('Policy file exceeds')) throw error;
    const code = SAFE_READ_CODES.has(error?.code) ? error.code : 'unavailable';
    throw new Error(`Could not read policy file (${code})`);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch (error) {
    throw new Error('Could not decode policy file as UTF-8');
  }
}

export async function loadPolicyFile(input, options = {}) {
  if (!isPlainRecord(options)) {
    throw new Error('Policy read options must be a plain object');
  }
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'maxPolicyBytes') throw new Error('Unsupported policy read option');
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')) {
      throw new Error('Policy read options must be data properties');
    }
  }
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Policy path must be a non-empty string');
  }
  if (input.startsWith('-')) {
    throw new Error('Policy path must not start with "-"');
  }
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(input) || /^file:/iu.test(input)) {
    throw new Error('Policy must be a local JSON file path, not a URL');
  }

  const maximumBytes = Object.hasOwn(options, 'maxPolicyBytes')
    ? options.maxPolicyBytes : MAX_POLICY_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_POLICY_BYTES) {
    throw new Error(`maxPolicyBytes must be an integer from 1 to ${MAX_POLICY_BYTES}`);
  }
  const path = resolve(input);
  const source = await readBoundedUtf8File(path, maximumBytes);

  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Could not parse policy file as JSON: ${parseFailureDetail(error, source)}`);
  }

  return { path, policy: parsePolicyObject(value) };
}

/**
 * Say why a policy file would not parse, without quoting any of it.
 *
 * V8 reports a parse failure two ways, and one of them embeds the input:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A policy
 * file short enough to be only a credential is therefore reproduced in full by
 * its own error message, and a longer one ten characters at a time -- a window
 * around the offending character, drawn from wherever in the file it sits.
 * `escapeTerminalText` at the CLI does not help: it escapes control characters
 * and leaves everything printable exactly as it was.
 *
 * The quoted form carries no position, so nothing diagnostic is lost by
 * reducing it to the offending token. The other form is all position and no
 * input, and is kept. The quoted window never leaves this function.
 *
 * The offending token is itself one character of the file, so it is named only
 * when it is printable. The quoted form is matched before the positional one
 * on purpose: a policy whose own bytes read `at position 12` would otherwise
 * be sliced after its own quoted copy.
 *
 * Kept here rather than imported from lib/audit.mjs, which already imports
 * this module; byCodeUnit below is duplicated for the same reason.
 */
export function parseFailureDetail(error, source) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const quoted = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/su.exec(message);
  if (quoted) {
    const printable = /^'[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]'$/u.test(quoted[1]);
    const what = printable ? `token ${quoted[1]}` : 'control character';
    const where = quoted[2] === undefined ? ' near the start' : '';
    return `unexpected ${what}${where}`;
  }
  const position = /at position \d+(?: \(line \d+ column \d+\))?/u.exec(message);
  if (position) {
    const detail = message.slice(0, position.index + position[0].length);
    if (/\(line \d+ column \d+\)$/u.test(detail) || typeof source !== 'string') return detail;
    const offset = /at position (\d+)/u.exec(position[0]);
    const index = Number(offset?.[1]);
    if (!Number.isSafeInteger(index) || index < 0 || index > source.length) return detail;
    const lines = source.slice(0, index).split(/\r\n|[\n\r\u2028\u2029]/u);
    return `${detail} (line ${lines.length} column ${lines.at(-1).length + 1})`;
  }
  if (/^Unexpected end of JSON input$/u.test(message)) return message;
  return 'it could not be parsed as JSON';
}

/** Order by UTF-16 code unit, deliberately not by locale. See lib/audit.mjs. */
function byCodeUnit(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isObservedCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function addThresholdFinding(findings, incompleteRules, policy, report, rule, metric, direction, code) {
  if (policy[rule] === undefined) return;
  const actual = report.summary[metric];
  if (!isObservedCount(actual)) {
    incompleteRules.push(rule);
    return;
  }
  const expected = policy[rule];
  const failed = direction === 'minimum' ? actual < expected : actual > expected;
  if (failed) findings.push({ code, actual, [direction]: expected });
}

function sortedFindings(findings) {
  return findings.sort((left, right) => {
    const code = byCodeUnit(left.code, right.code);
    if (code !== 0) return code;
    return byCodeUnit(
      String(left.hostOrdinal ?? left.host ?? left.scheme ?? ''),
      String(right.hostOrdinal ?? right.host ?? right.scheme ?? ''),
    );
  });
}

export function evaluatePolicy(report, policyInput) {
  if (!isPlainRecord(report) || !isPlainRecord(report.summary)) {
    throw new Error('Audit report must contain a summary object');
  }
  const policy = parsePolicyObject(policyInput);
  const findings = [];
  const incompleteRules = [];
  const internal = auditEvidence.get(report);
  const hostRows = internal?.hosts ?? (report.schemaVersion === 2 ? null : report.hosts);
  const partialUrlIndex = !isObservedCount(report.summary.invalidUrls)
    || report.summary.invalidUrls > 0;

  if (policy.allowedHosts) {
    const allowed = new Set(policy.allowedHosts);
    if (partialUrlIndex || !Array.isArray(hostRows)) incompleteRules.push('allowedHosts');
    for (const { name: host, count, ordinal } of Array.isArray(hostRows) ? hostRows : []) {
      if (!allowed.has(host)) findings.push({
        code: 'DISALLOWED_HOST',
        ...(ordinal === undefined ? { host } : { hostOrdinal: ordinal }),
        count,
      });
    }
  }
  if (policy.allowedSchemes) {
    const allowed = new Set(policy.allowedSchemes);
    if (partialUrlIndex || !Array.isArray(report.schemes)) incompleteRules.push('allowedSchemes');
    for (const { name: scheme, count } of Array.isArray(report.schemes) ? report.schemes : []) {
      if (!allowed.has(scheme)) findings.push({ code: 'DISALLOWED_SCHEME', scheme, count });
    }
  }

  addThresholdFinding(findings, incompleteRules, policy, report, 'minUniqueUrls', 'uniqueUrls', 'minimum', 'MIN_UNIQUE_URLS');
  addThresholdFinding(findings, incompleteRules, policy, report, 'minUniqueImages', 'uniqueImages', 'minimum', 'MIN_UNIQUE_IMAGES');
  addThresholdFinding(findings, incompleteRules, policy, report, 'maxDuplicateUrls', 'duplicateUrls', 'maximum', 'MAX_DUPLICATE_URLS');
  addThresholdFinding(findings, incompleteRules, policy, report, 'maxDuplicateUrlEntries', 'duplicateUrlEntries', 'maximum', 'MAX_DUPLICATE_URL_ENTRIES');
  addThresholdFinding(findings, incompleteRules, policy, report, 'maxInvalidLastmodValues', 'invalidLastmodValues', 'maximum', 'MAX_INVALID_LASTMOD_VALUES');
  addThresholdFinding(findings, incompleteRules, policy, report, 'maxFragmentUrls', 'fragmentUrls', 'maximum', 'MAX_FRAGMENT_URLS');
  addThresholdFinding(findings, incompleteRules, policy, report, 'maxInvalidUrls', 'invalidUrls', 'maximum', 'MAX_INVALID_URLS');
  addThresholdFinding(findings, incompleteRules, policy, report, 'maxMissingLocs', 'missingLocs', 'maximum', 'MAX_MISSING_LOCS');

  if (policy.maxRemovedUrls !== undefined) {
    if (!report.comparison) {
      throw new Error('Policy rule "maxRemovedUrls" requires a comparison report');
    }
    if (!isObservedCount(report.comparison.removedCount)) {
      incompleteRules.push('maxRemovedUrls');
    } else if (report.comparison.removedCount > policy.maxRemovedUrls) {
      findings.push({
        code: 'MAX_REMOVED_URLS',
        actual: report.comparison.removedCount,
        maximum: policy.maxRemovedUrls,
      });
    }
  }

  sortedFindings(findings);
  const status = incompleteRules.length > 0 ? 'incomplete' : findings.length > 0 ? 'fail' : 'pass';
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    status,
    passed: status === 'incomplete' ? null : status === 'pass',
    incompleteRules,
    findings,
  };
}

export function policyFindingMessage(finding) {
  switch (finding.code) {
    case 'DISALLOWED_HOST':
      return `Host ${finding.hostOrdinal === undefined ? finding.host : `#${finding.hostOrdinal}`} is not allowed (${finding.count} URL${finding.count === 1 ? '' : 's'})`;
    case 'DISALLOWED_SCHEME':
      return `Scheme ${finding.scheme} is not allowed (${finding.count} URL${finding.count === 1 ? '' : 's'})`;
    default: {
      const metric = FINDING_LABELS[finding.code] ?? finding.code;
      if (finding.minimum !== undefined) {
        return `${metric}: ${finding.actual}; minimum ${finding.minimum}`;
      }
      return `${metric}: ${finding.actual}; maximum ${finding.maximum}`;
    }
  }
}
