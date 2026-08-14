import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';

export const POLICY_SCHEMA_VERSION = 1;

const MAX_POLICY_BYTES = 64 * 1024;
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
      throw new Error(`Policy property "${key}" contains an unsupported value: ${item}`);
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
    throw new Error(`Unknown policy ${unknown.length === 1 ? 'property' : 'properties'}: ${unknown.join(', ')}`);
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
    if (error.message.startsWith('Policy file exceeds')) throw error;
    throw new Error(`Could not read policy file ${path}: ${error.message}`);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch (error) {
    throw new Error(`Could not decode policy file ${path} as UTF-8: ${error.message}`);
  }
}

export async function loadPolicyFile(input, options = {}) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Policy path must be a non-empty string');
  }
  if (input.startsWith('-')) {
    throw new Error('Policy path must not start with "-"');
  }
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(input) || /^file:/iu.test(input)) {
    throw new Error('Policy must be a local JSON file path, not a URL');
  }

  const maximumBytes = options.maxPolicyBytes ?? MAX_POLICY_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_POLICY_BYTES) {
    throw new Error(`maxPolicyBytes must be an integer from 1 to ${MAX_POLICY_BYTES}`);
  }
  const path = resolve(input);
  const source = await readBoundedUtf8File(path, maximumBytes);

  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Could not parse policy file ${path} as JSON: ${error.message}`);
  }

  return { path, policy: parsePolicyObject(value) };
}

function addThresholdFinding(findings, policy, report, rule, metric, direction, code) {
  if (policy[rule] === undefined) return;
  const actual = report.summary[metric];
  const expected = policy[rule];
  const failed = direction === 'minimum' ? actual < expected : actual > expected;
  if (failed) findings.push({ code, actual, [direction]: expected });
}

function sortedFindings(findings) {
  return findings.sort((left, right) => {
    const code = left.code.localeCompare(right.code);
    if (code !== 0) return code;
    return String(left.host ?? left.scheme ?? '').localeCompare(String(right.host ?? right.scheme ?? ''));
  });
}

export function evaluatePolicy(report, policyInput) {
  if (!isPlainRecord(report) || !isPlainRecord(report.summary)) {
    throw new Error('Audit report must contain a summary object');
  }
  const policy = parsePolicyObject(policyInput);
  const findings = [];

  if (policy.allowedHosts) {
    const allowed = new Set(policy.allowedHosts);
    for (const { name: host, count } of report.hosts ?? []) {
      if (!allowed.has(host)) findings.push({ code: 'DISALLOWED_HOST', host, count });
    }
  }
  if (policy.allowedSchemes) {
    const allowed = new Set(policy.allowedSchemes);
    for (const { name: scheme, count } of report.schemes ?? []) {
      if (!allowed.has(scheme)) findings.push({ code: 'DISALLOWED_SCHEME', scheme, count });
    }
  }

  addThresholdFinding(findings, policy, report, 'minUniqueUrls', 'uniqueUrls', 'minimum', 'MIN_UNIQUE_URLS');
  addThresholdFinding(findings, policy, report, 'minUniqueImages', 'uniqueImages', 'minimum', 'MIN_UNIQUE_IMAGES');
  addThresholdFinding(findings, policy, report, 'maxDuplicateUrls', 'duplicateUrls', 'maximum', 'MAX_DUPLICATE_URLS');
  addThresholdFinding(findings, policy, report, 'maxDuplicateUrlEntries', 'duplicateUrlEntries', 'maximum', 'MAX_DUPLICATE_URL_ENTRIES');
  addThresholdFinding(findings, policy, report, 'maxInvalidLastmodValues', 'invalidLastmodValues', 'maximum', 'MAX_INVALID_LASTMOD_VALUES');
  addThresholdFinding(findings, policy, report, 'maxFragmentUrls', 'fragmentUrls', 'maximum', 'MAX_FRAGMENT_URLS');
  addThresholdFinding(findings, policy, report, 'maxInvalidUrls', 'invalidUrls', 'maximum', 'MAX_INVALID_URLS');
  addThresholdFinding(findings, policy, report, 'maxMissingLocs', 'missingLocs', 'maximum', 'MAX_MISSING_LOCS');

  if (policy.maxRemovedUrls !== undefined) {
    if (!report.comparison) {
      throw new Error('Policy rule "maxRemovedUrls" requires a comparison report');
    }
    if (report.comparison.removedCount > policy.maxRemovedUrls) {
      findings.push({
        code: 'MAX_REMOVED_URLS',
        actual: report.comparison.removedCount,
        maximum: policy.maxRemovedUrls,
      });
    }
  }

  sortedFindings(findings);
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    passed: findings.length === 0,
    findings,
  };
}

export function policyFindingMessage(finding) {
  switch (finding.code) {
    case 'DISALLOWED_HOST':
      return `Host ${finding.host} is not allowed (${finding.count} URL${finding.count === 1 ? '' : 's'})`;
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
