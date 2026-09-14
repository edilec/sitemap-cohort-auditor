/**
 * What a `JSON.parse` failure may not quote back.
 *
 * V8 reports a parse failure two ways, and one of them embeds the input:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A policy
 * file short enough to be only a credential was therefore reproduced in full
 * on stderr by `Policy error: Could not parse policy file ... as JSON: ...`.
 *
 * `escapeTerminalText` at the CLI does not catch it: it escapes control
 * characters and leaves everything printable exactly as it arrived, and a
 * credential is printable.
 *
 * `AKIAIOSFODNN7EXAMPLE` is the AWS documentation placeholder, not a key.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPolicyFile, parseFailureDetail } from '../lib/policy.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testDirectory, '..');
const root = resolve(testDirectory, 'fixtures/root.xml');
const cli = resolve(projectDirectory, 'bin/sitemap-cohort-auditor.mjs');

const CANARY = 'AKIAIOSFODNN7EXAMPLE';

// Longer than V8's ten-character window, so a leak is a prefix rather than the
// whole string. Truncating the message would not have caught this one.
const LONG_SECRET = 'password=hunter2-correct-horse-battery-staple';

const MIN_RUN = 8;

/**
 * Assert that no run of `secret` eight characters or longer survives.
 *
 * Every run, not only every prefix: V8 quotes a window around the offending
 * character, so a secret in the middle of a file leaks from its middle.
 * Asserting only on the whole string would pass against output that printed
 * `AKIAIOSF` and called that truncation.
 */
function assertNoLeak(secret, ...streams) {
  const haystack = streams.join('\n');
  for (let length = secret.length; length >= MIN_RUN; length -= 1) {
    for (let start = 0; start + length <= secret.length; start += 1) {
      const window = secret.slice(start, start + length);
      assert.equal(haystack.includes(window), false, `output echoed ${JSON.stringify(window)}`);
    }
  }
}

/** Write `text` as a policy file and run the real binary over a real sitemap. */
async function runPolicy(t, text, extraArgs = []) {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-policy-parse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policyPath = join(directory, 'policy.json');
  await writeFile(policyPath, text);
  return spawnSync(process.execPath, [cli, root, '--policy', policyPath, ...extraArgs], {
    encoding: 'utf8',
  });
}

test('a policy file that is only a credential is not quoted back', async (t) => {
  const result = await runPolicy(t, CANARY);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Policy error: Could not parse policy file/);
  assertNoLeak(CANARY, result.stdout, result.stderr);
});

test('a policy file that is only a credential is not quoted back in --json mode either', async (t) => {
  const result = await runPolicy(t, CANARY, ['--json']);
  assertNoLeak(CANARY, result.stdout, result.stderr);
});

test("a secret longer than V8's quoting window does not leak its prefix either", async (t) => {
  const result = await runPolicy(t, LONG_SECRET);
  assertNoLeak(LONG_SECRET, result.stdout, result.stderr);
  assert.equal(result.stderr.includes('password=h'), false);
});

test('a secret sitting mid-file does not leak through the windowed form', async (t) => {
  // V8 answers this one with `Unexpected token '}', "[ }AKIAIOSFO"...`: the
  // shape that quotes a window rather than a leading prefix.
  const result = await runPolicy(t, `[ }${CANARY}]`);
  assertNoLeak(CANARY, result.stdout, result.stderr);
});

test('the position, line and column of a parse failure survive the fix', async (t) => {
  const result = await runPolicy(t, '{"schemaVersion": 1 "minUniqueUrls": 1}');
  assert.match(result.stderr, /at position 20 \(line 1 column 21\)/);
});

test('a parse failure still names the token: a diagnostic that says nothing is its own defect', async (t) => {
  const result = await runPolicy(t, CANARY);
  assert.match(result.stderr, /unexpected token 'A'/);
});

test('loadPolicyFile throws the same bounded detail the CLI prints', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-policy-parse-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policyPath = join(directory, 'policy.json');
  await writeFile(policyPath, CANARY);

  await assert.rejects(
    () => loadPolicyFile(policyPath),
    (error) => {
      assertNoLeak(CANARY, error.message);
      assert.match(error.message, /unexpected token 'A' near the start/);
      return true;
    },
  );
});

test('parseFailureDetail keeps the position and drops the quoted window', () => {
  const detail = (text) => {
    try {
      JSON.parse(text);
      throw new Error('that text parsed');
    } catch (error) {
      return parseFailureDetail(error);
    }
  };

  // The positional form is all position and no input, and is kept whole.
  assert.equal(
    detail('{"schemaVersion": 1 "minUniqueUrls": 1}'),
    "Expected ',' or '}' after property value in JSON at position 20 (line 1 column 21)",
  );
  assert.equal(detail('{"a":1}x'), 'Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)');
  assert.equal(detail(''), 'Unexpected end of JSON input');
  assert.equal(detail('[1,2,'), 'Unexpected end of JSON input');

  // Every quoted shape: the whole input, a leading prefix, and a window.
  assert.equal(detail(CANARY), "unexpected token 'A' near the start");
  assert.equal(detail(LONG_SECRET), "unexpected token 'p' near the start");
  assert.equal(detail(`[ }${CANARY}]`), "unexpected token '}' near the start");
  assert.equal(detail(`{"aaaaaaaaaaaaaa": [ }${CANARY} ]}`), "unexpected token '}'");
});

test('parseFailureDetail refuses a policy whose own bytes imitate a position', () => {
  // The quoted form is matched first for exactly this reason.
  let detail;
  try {
    JSON.parse(`at position 12 ${CANARY}`);
  } catch (error) {
    detail = parseFailureDetail(error);
  }
  assertNoLeak(CANARY, detail);
  assert.equal(detail.includes('at position 12'), false);
});

test('parseFailureDetail does not print a control character that arrives as the token', () => {
  // The offending character is one byte of the file, so it is named only when
  // it is printable.
  let detail;
  try {
    JSON.parse(String.fromCharCode(0x1B));
  } catch (error) {
    detail = parseFailureDetail(error);
  }
  assert.equal(detail.includes(String.fromCharCode(0x1B)), false);
  assert.equal(detail, 'unexpected control character near the start');
});

test('parseFailureDetail says something for an error it does not recognise', () => {
  assert.equal(parseFailureDetail(undefined), 'it could not be parsed as JSON');
  assert.equal(parseFailureDetail(new Error('something else entirely')), 'it could not be parsed as JSON');
});
