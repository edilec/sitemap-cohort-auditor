import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const cli = resolve('bin/sitemap-cohort-auditor.mjs');
const release = resolve('examples/release');
const current = resolve(release, 'after/index.xml');
const baseline = resolve(release, 'before.xml');
const policy = resolve(release, 'policy.json');

function run(...flags) {
  return spawnSync(process.execPath, [cli, current, ...flags], { encoding: 'utf8' });
}

test('one value for each CLI option and repeated boolean --json stay valid', () => {
  const result = run('--root', release, '--compare', baseline,
    '--policy', policy, '--timeout-ms', '60000', '--json', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'pass');
});

test('a second value-bearing CLI flag cannot erase the first input', () => {
  const cases = [
    ['--compare', ['--root', release, '--compare', resolve(release, 'missing.xml'), '--compare', baseline]],
    ['--root', ['--root', resolve(release, 'missing-root'), '--root', release]],
    ['--policy', ['--root', release, '--compare', baseline,
      '--policy', resolve(release, 'missing-policy.json'), '--policy', policy]],
    ['--timeout-ms', ['--root', release, '--timeout-ms', '0', '--timeout-ms', '60000']],
  ];
  for (const [flag, args] of cases) {
    const result = run(...args, '--json');
    assert.equal(result.status, 2, `${flag}: ${result.stderr}`);
    assert.equal(result.stdout, '', `${flag} must not report pass`);
    assert.match(result.stderr, new RegExp(flag));
  }
});
