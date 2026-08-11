#!/usr/bin/env node

import {
  auditSitemap,
  escapeTerminalText,
  formatJsonReport,
  formatTextReport,
  VERSION,
} from '../lib/audit.mjs';

const HELP = `sitemap-cohort-auditor ${VERSION}

Usage:
  sitemap-cohort-auditor <SITEMAP> [--compare <OLD_SITEMAP>] [--json]

Arguments:
  SITEMAP              Local sitemap XML/.gz file or HTTPS URL

Options:
  --compare <SOURCE>   Compare the current unique URL cohort with an older sitemap
  --json               Emit deterministic JSON instead of a text summary
  -h, --help           Show this help
  -v, --version        Show the version
`;

function parseArguments(argv) {
  const options = { source: null, compare: null, json: false, help: false, version: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--compare') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('--compare requires a local sitemap path or HTTPS URL');
      }
      options.compare = value;
      index += 1;
    } else if (argument === '-h' || argument === '--help') {
      options.help = true;
    } else if (argument === '-v' || argument === '--version') {
      options.version = true;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (options.source === null) {
      options.source = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  return options;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${escapeTerminalText(error.message)}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (!options.source) {
    console.error(`Error: a sitemap source is required\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  try {
    const report = await auditSitemap(options.source, { compare: options.compare });
    const output = options.json
      ? formatJsonReport(report)
      : formatTextReport(report);
    process.stdout.write(output);
  } catch (error) {
    console.error(`Audit failed: ${escapeTerminalText(error.message)}`);
    process.exitCode = 1;
  }
}

await main();
