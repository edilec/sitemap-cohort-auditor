import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testDirectory, '..');
const cli = resolve(projectDirectory, 'bin/sitemap-cohort-auditor.mjs');
const exampleDirectory = resolve(projectDirectory, 'examples/release');

function normalizeProjectPaths(value) {
  if (Array.isArray(value)) return value.map(normalizeProjectPaths);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeProjectPaths(item)]),
    );
  }
  if (typeof value !== 'string' || !isAbsolute(value)) return value;

  const localPath = relative(projectDirectory, value);
  if (localPath === '..' || localPath.startsWith(`..${sep}`) || isAbsolute(localPath)) {
    return value;
  }
  return `./${localPath.split(sep).join('/')}`;
}

test('CLI version matches package metadata', async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(projectDirectory, 'package.json'), 'utf8'),
  );
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${packageJson.version}\n`);
});

test('checked-in release report matches the CLI, comparison, and policy fixtures', async () => {
  const result = spawnSync(process.execPath, [
    cli,
    resolve(exampleDirectory, 'after/index.xml'),
    '--root', exampleDirectory,
    '--compare',
    resolve(exampleDirectory, 'before.xml'),
    '--policy',
    resolve(exampleDirectory, 'policy.json'),
    '--json',
  ], {
    cwd: projectDirectory,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');

  const actual = normalizeProjectPaths(JSON.parse(result.stdout));
  const expected = JSON.parse(
    await readFile(resolve(exampleDirectory, 'report.json'), 'utf8'),
  );
  assert.deepEqual(actual, expected);
});
