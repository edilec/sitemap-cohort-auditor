import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { loadPolicyFile } from '../lib/policy.mjs';

const cli = resolve('bin/sitemap-cohort-auditor.mjs');
const sitemap = resolve('examples/release/before.xml');

test('policy file errors keep private paths and OS messages out of CLI and API diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sitemap-policy-private-'));
  try {
    const missing = join(directory, 'SYNTHETIC_SECRET_CANARY.json');
    for (const outputFlag of [[], ['--json']]) {
      const result = spawnSync(process.execPath, [cli, sitemap, '--policy', missing, ...outputFlag], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Policy error: Could not read policy file.*ENOENT/);
      assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_SECRET_CANARY'), false);
      assert.equal((result.stdout + result.stderr).includes(directory), false);
    }
    await assert.rejects(loadPolicyFile(missing), (error) =>
      /Could not read policy file.*ENOENT/.test(error.message)
      && !error.message.includes('SYNTHETIC_SECRET_CANARY'));

    const malformed = join(directory, 'SYNTHETIC_SECRET_CANARY-malformed.json');
    await writeFile(malformed, '{"schemaVersion": 1 "minUniqueUrls": 1}');
    await assert.rejects(loadPolicyFile(malformed), (error) =>
      /Could not parse policy file.*position \d+/.test(error.message)
      && !error.message.includes('SYNTHETIC_SECRET_CANARY'));
    const malformedCli = spawnSync(process.execPath,
      [cli, sitemap, '--policy', malformed, '--json'], { encoding: 'utf8' });
    assert.equal(malformedCli.status, 2);
    assert.equal(malformedCli.stdout, '');
    assert.match(malformedCli.stderr, /at position 20 \(line 1 column 21\)/);
    assert.equal(malformedCli.stderr.includes('SYNTHETIC_SECRET_CANARY'), false);
    assert.equal(malformedCli.stderr.includes(directory), false);

    const invalidUtf8 = join(directory, 'SYNTHETIC_SECRET_CANARY-utf8.json');
    await writeFile(invalidUtf8, Buffer.from([0x7b, 0xff, 0x7d]));
    await assert.rejects(loadPolicyFile(invalidUtf8), (error) =>
      /Could not decode policy file as UTF-8/.test(error.message)
      && !error.message.includes('SYNTHETIC_SECRET_CANARY'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
