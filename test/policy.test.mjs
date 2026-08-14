import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditSitemap } from '../lib/audit.mjs';
import {
  evaluatePolicy,
  loadPolicyFile,
  parsePolicyObject,
  policyFindingMessage,
} from '../lib/policy.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testDirectory, '..');
const root = resolve(testDirectory, 'fixtures/root.xml');
const old = resolve(testDirectory, 'fixtures/old.xml');
const cli = resolve(projectDirectory, 'bin/sitemap-cohort-auditor.mjs');

function completeReport(overrides = {}) {
  return {
    summary: {
      uniqueUrls: 10,
      uniqueImages: 5,
      duplicateUrls: 1,
      duplicateUrlEntries: 2,
      invalidLastmodValues: 3,
      fragmentUrls: 4,
      invalidUrls: 5,
      missingLocs: 6,
      ...overrides.summary,
    },
    hosts: [
      { name: 'bad.example', count: 1 },
      { name: 'example.com', count: 9 },
    ],
    schemes: [
      { name: 'http', count: 1 },
      { name: 'https', count: 9 },
    ],
    comparison: { removedCount: 2 },
    ...overrides,
  };
}

test('parses a strict versioned policy and normalizes set-like rules', () => {
  const policy = parsePolicyObject({
    schemaVersion: 1,
    allowedHosts: ['Example.COM', 'www.example.com'],
    allowedSchemes: ['HTTPS'],
    minUniqueUrls: 0,
    maxInvalidUrls: 0,
  });

  assert.equal(Object.getPrototypeOf(policy), null);
  assert.deepEqual([...policy.allowedHosts], ['example.com', 'www.example.com']);
  assert.deepEqual([...policy.allowedSchemes], ['https']);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.allowedHosts), true);
  assert.equal(Object.isFrozen(policy.allowedSchemes), true);
});

test('rejects malformed, ambiguous, and unknown policy properties', () => {
  const invalid = [
    [null, /must be a JSON object/],
    [[], /must be a JSON object/],
    [{}, /schemaVersion.*required/],
    [{ schemaVersion: 2, minUniqueUrls: 1 }, /schemaVersion must be 1/],
    [{ schemaVersion: 1 }, /at least one rule/],
    [{ schemaVersion: 1, mystery: 0 }, /Unknown policy property: mystery/],
    [{ schemaVersion: 1, minUniqueUrls: -1 }, /non-negative safe integer/],
    [{ schemaVersion: 1, minUniqueUrls: 1.5 }, /non-negative safe integer/],
    [{ schemaVersion: 1, minUniqueUrls: Number.MAX_SAFE_INTEGER + 1 }, /non-negative safe integer/],
    [{ schemaVersion: 1, allowedHosts: [] }, /non-empty array/],
    [{ schemaVersion: 1, allowedHosts: [' example.com'] }, /non-empty trimmed strings/],
    [{ schemaVersion: 1, allowedHosts: ['https://example.com'] }, /unsupported value/],
    [{ schemaVersion: 1, allowedHosts: ['Example.com', 'example.com'] }, /duplicate values/],
    [{ schemaVersion: 1, allowedSchemes: ['ftp'] }, /unsupported value/],
    [{ schemaVersion: 1, allowedSchemes: ['HTTPS', 'https'] }, /duplicate values/],
  ];

  for (const [value, pattern] of invalid) {
    assert.throws(() => parsePolicyObject(value), pattern);
  }

  const accessor = { schemaVersion: 1 };
  Object.defineProperty(accessor, 'minUniqueUrls', { enumerable: true, get: () => 1 });
  assert.throws(() => parsePolicyObject(accessor), /must be a data property/);

  const symbol = { schemaVersion: 1, minUniqueUrls: 1, [Symbol('hidden')]: true };
  assert.throws(() => parsePolicyObject(symbol), /symbol properties/);
});

test('evaluates every supported rule with stable structured findings', () => {
  const result = evaluatePolicy(completeReport(), {
    schemaVersion: 1,
    allowedHosts: ['example.com'],
    allowedSchemes: ['https'],
    minUniqueUrls: 11,
    minUniqueImages: 6,
    maxDuplicateUrls: 0,
    maxDuplicateUrlEntries: 1,
    maxInvalidLastmodValues: 2,
    maxFragmentUrls: 3,
    maxInvalidUrls: 4,
    maxMissingLocs: 5,
    maxRemovedUrls: 1,
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.findings.map(({ code }) => code), [
    'DISALLOWED_HOST',
    'DISALLOWED_SCHEME',
    'MAX_DUPLICATE_URL_ENTRIES',
    'MAX_DUPLICATE_URLS',
    'MAX_FRAGMENT_URLS',
    'MAX_INVALID_LASTMOD_VALUES',
    'MAX_INVALID_URLS',
    'MAX_MISSING_LOCS',
    'MAX_REMOVED_URLS',
    'MIN_UNIQUE_IMAGES',
    'MIN_UNIQUE_URLS',
  ]);
  assert.deepEqual(result.findings[0], {
    code: 'DISALLOWED_HOST',
    host: 'bad.example',
    count: 1,
  });
  assert.deepEqual(result.findings.at(-1), {
    code: 'MIN_UNIQUE_URLS',
    actual: 10,
    minimum: 11,
  });
  assert.deepEqual(evaluatePolicy(completeReport(), {
    schemaVersion: 1,
    minUniqueUrls: 11,
  }), evaluatePolicy(completeReport(), {
    minUniqueUrls: 11,
    schemaVersion: 1,
  }));
});

test('treats exact thresholds as passing boundaries', () => {
  const result = evaluatePolicy(completeReport(), {
    schemaVersion: 1,
    allowedHosts: ['bad.example', 'example.com'],
    allowedSchemes: ['http', 'https'],
    minUniqueUrls: 10,
    minUniqueImages: 5,
    maxDuplicateUrls: 1,
    maxDuplicateUrlEntries: 2,
    maxInvalidLastmodValues: 3,
    maxFragmentUrls: 4,
    maxInvalidUrls: 5,
    maxMissingLocs: 6,
    maxRemovedUrls: 2,
  });

  assert.deepEqual(result, { schemaVersion: 1, passed: true, findings: [] });
});

test('requires a comparison only when maxRemovedUrls is configured', () => {
  const report = completeReport();
  delete report.comparison;

  assert.throws(() => evaluatePolicy(report, {
    schemaVersion: 1,
    maxRemovedUrls: 0,
  }), /requires a comparison report/);
  assert.equal(evaluatePolicy(report, {
    schemaVersion: 1,
    maxInvalidUrls: 5,
  }).passed, true);
});

test('formats every policy finding without executing untrusted text', () => {
  assert.equal(
    policyFindingMessage({ code: 'DISALLOWED_HOST', host: 'bad.example', count: 2 }),
    'Host bad.example is not allowed (2 URLs)',
  );
  assert.equal(
    policyFindingMessage({ code: 'DISALLOWED_SCHEME', scheme: 'http', count: 1 }),
    'Scheme http is not allowed (1 URL)',
  );
  assert.equal(
    policyFindingMessage({ code: 'MIN_UNIQUE_URLS', actual: 9, minimum: 10 }),
    'Unique URLs: 9; minimum 10',
  );
});

test('loads only bounded local UTF-8 JSON policy files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const validPath = join(directory, 'policy.json');
  await writeFile(validPath, JSON.stringify({ schemaVersion: 1, maxInvalidUrls: 0 }));

  const loaded = await loadPolicyFile(validPath);
  assert.equal(loaded.path, validPath);
  assert.equal(loaded.policy.maxInvalidUrls, 0);

  await assert.rejects(loadPolicyFile('https://example.com/policy.json'), /local JSON file path/);
  await assert.rejects(loadPolicyFile('ftp://example.com/policy.json'), /local JSON file path/);
  await assert.rejects(loadPolicyFile('file:///tmp/policy.json'), /local JSON file path/);
  await assert.rejects(loadPolicyFile(''), /non-empty string/);
  await assert.rejects(loadPolicyFile('-policy.json'), /must not start/);
  await assert.rejects(loadPolicyFile(validPath, { maxPolicyBytes: 0 }), /maxPolicyBytes/);
  await assert.rejects(loadPolicyFile(validPath, { maxPolicyBytes: 65_537 }), /maxPolicyBytes/);
  await assert.rejects(loadPolicyFile(validPath, { maxPolicyBytes: 10 }), /exceeds the 10 byte limit/);

  const malformedPath = join(directory, 'malformed.json');
  await writeFile(malformedPath, '{');
  await assert.rejects(loadPolicyFile(malformedPath), /Could not parse policy file/);

  const invalidUtf8Path = join(directory, 'invalid-utf8.json');
  await writeFile(invalidUtf8Path, Buffer.from([0x7b, 0xff, 0x7d]));
  await assert.rejects(loadPolicyFile(invalidUtf8Path), /Could not decode policy file/);

  const oversizedPath = join(directory, 'oversized.json');
  await writeFile(oversizedPath, ' '.repeat(65_537));
  await assert.rejects(loadPolicyFile(oversizedPath), /exceeds the 65,536 byte limit/);
});

test('CLI preserves existing output when no policy is supplied', () => {
  const json = spawnSync(process.execPath, [cli, root, '--json'], { encoding: 'utf8' });
  assert.equal(json.status, 0);
  assert.equal(json.stderr, '');
  assert.equal(Object.hasOwn(JSON.parse(json.stdout), 'policy'), false);

  const text = spawnSync(process.execPath, [cli, root], { encoding: 'utf8' });
  assert.equal(text.status, 0);
  assert.equal(text.stderr, '');
  assert.equal(text.stdout.includes('\nPolicy:'), false);
});

test('CLI exits zero for a passing policy and includes deterministic policy output', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-policy-pass-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policyPath = join(directory, 'policy.json');
  await writeFile(policyPath, JSON.stringify({
    schemaVersion: 1,
    allowedHosts: ['edilec.com', 'legacy.example.org', 'www.edilec.com'],
    allowedSchemes: ['http', 'https'],
    minUniqueUrls: 5,
    maxInvalidUrls: 1,
    maxRemovedUrls: 1,
  }));

  const args = [cli, root, '--compare', old, '--policy', policyPath, '--json'];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 0);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(JSON.parse(first.stdout).policy, {
    schemaVersion: 1,
    passed: true,
    findings: [],
    source: policyPath,
  });

  const missingComparison = spawnSync(
    process.execPath,
    [cli, root, '--policy', policyPath],
    { encoding: 'utf8' },
  );
  assert.equal(missingComparison.status, 2);
  assert.equal(missingComparison.stdout, '');
  assert.match(missingComparison.stderr, /maxRemovedUrls requires --compare/);
});

test('CLI exits three for policy findings while still emitting the full report', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-policy-fail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policyPath = join(directory, 'policy.json');
  await writeFile(policyPath, JSON.stringify({
    schemaVersion: 1,
    allowedHosts: ['edilec.com'],
    allowedSchemes: ['https'],
    maxInvalidUrls: 0,
  }));

  const result = spawnSync(process.execPath, [cli, root, '--policy', policyPath, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 3);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.uniqueUrls, 5);
  assert.equal(report.policy.passed, false);
  assert.deepEqual(report.policy.findings.map(({ code }) => code), [
    'DISALLOWED_HOST',
    'DISALLOWED_HOST',
    'DISALLOWED_SCHEME',
    'MAX_INVALID_URLS',
  ]);
});

test('CLI treats invalid policy configuration as a usage error', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-policy-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policyPath = join(directory, 'policy.json');
  await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, unknown: 0 }));

  const invalid = spawnSync(process.execPath, [cli, root, '--policy', policyPath], {
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /Policy error: Unknown policy property/);

  const missingValue = spawnSync(process.execPath, [cli, root, '--policy'], { encoding: 'utf8' });
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /--policy requires a local JSON file path/);
});

test('policy evaluation integrates with a real audit report', async () => {
  const report = await auditSitemap(root, { compare: old });
  const result = evaluatePolicy(report, {
    schemaVersion: 1,
    minUniqueUrls: 5,
    minUniqueImages: 3,
    maxDuplicateUrls: 1,
    maxInvalidLastmodValues: 3,
    maxFragmentUrls: 2,
    maxInvalidUrls: 1,
    maxMissingLocs: 0,
    maxRemovedUrls: 1,
  });
  assert.equal(result.passed, true);
});
