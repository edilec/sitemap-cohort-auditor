#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', 'node_modules']);

async function findMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findMarkdownFiles(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') files.push(path);
  }
  return files;
}

function markdownWithoutFencedCode(source) {
  return source.replace(/^(```|~~~)[\s\S]*?^\1\s*$/gmu, '');
}

function localTarget(rawTarget) {
  const target = rawTarget.startsWith('<') && rawTarget.endsWith('>')
    ? rawTarget.slice(1, -1)
    : rawTarget;
  if (/^(?:https?:|mailto:)/iu.test(target) || target.startsWith('#')) return null;
  const path = target.split('#', 1)[0].split('?', 1)[0];
  if (path.length === 0) return null;
  return decodeURIComponent(path);
}

const failures = [];
const markdownFiles = await findMarkdownFiles(projectDirectory);

for (const file of markdownFiles) {
  const relativeFile = relative(projectDirectory, file).split(sep).join('/');
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    failures.push(`${relativeFile}: could not read file (${error.message})`);
    continue;
  }

  const withoutCode = markdownWithoutFencedCode(source);
  const links = withoutCode.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu);
  for (const match of links) {
    const target = localTarget(match[1].trim());
    if (target === null) continue;
    const resolvedTarget = resolve(dirname(file), target);
    try {
      await access(resolvedTarget);
    } catch {
      failures.push(`${relativeFile}: missing local target ${match[1].trim()}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Documentation link check failed:\n${failures.map((item) => `- ${item}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Checked local links in ${markdownFiles.length} Markdown files.`);
}
