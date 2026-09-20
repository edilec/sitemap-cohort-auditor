# Sitemap Cohort Auditor

[![CI](https://github.com/edilec/sitemap-cohort-auditor/actions/workflows/ci.yml/badge.svg)](https://github.com/edilec/sitemap-cohort-auditor/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/edilec/sitemap-cohort-auditor?label=release)](https://github.com/edilec/sitemap-cohort-auditor/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-555.svg)](./LICENSE)
[![Security policy](https://img.shields.io/badge/security-policy-555.svg)](https://github.com/edilec/sitemap-cohort-auditor/security/policy)

A dependency-free Node.js command-line utility for checking sitemap cohorts before and after a site release. It follows nested sitemap indexes, counts page and image entries, and highlights changes or metadata problems that are easy to miss in very large sitemaps.

**Status:** maintained. The supported runtime is Node.js 20 or newer; CI covers
Node.js 20, 22, and 24. Reports use schema version `1`; release-policy files use
schema version `1`.

## Requirements

- Node.js 20 or newer
- A local sitemap XML/XML.GZ file or an HTTPS sitemap URL

The utility uses only Node built-ins. It does not send results to a service or require an API key.

## Install and run locally

```sh
npm install
npm test
node ./bin/sitemap-cohort-auditor.mjs ./sitemap.xml
```

After installing the package globally or linking it with `npm link`, use the shorter executable name:

```sh
sitemap-cohort-auditor ./sitemap.xml
```

To install the recommended release directly from its checksummed package:

```sh
npm install --global https://github.com/edilec/sitemap-cohort-auditor/releases/download/v0.2.2/sitemap-cohort-auditor-0.2.2.tgz
sitemap-cohort-auditor ./sitemap.xml
```

Release artifacts and checksums are available on the [latest release page](https://github.com/edilec/sitemap-cohort-auditor/releases/latest).

Remote input must use HTTPS:

```sh
sitemap-cohort-auditor https://example.com/sitemap.xml
```

## Compare two URL cohorts

Use the current sitemap as the main argument and the older sitemap after `--compare`:

```sh
sitemap-cohort-auditor ./after/sitemap.xml --compare ./before/sitemap.xml
```

The comparison uses exact, decoded `<loc>` strings from unique URL entries. It reports URLs added to the current cohort and URLs removed from it. Invalid URL strings are retained in this comparison so a malformed entry cannot silently disappear from review.

### Compare against an earlier report

After a release the previous sitemap is usually gone, but the audit artifact
you stored is not. `--compare` also accepts an earlier `--json` report from
this tool, so a CI job can compare each release against the one before it
without keeping old sitemaps around.

A report only carries its URL list when it was produced with `--with-cohort`:

```sh
# during the release that is about to become "before"
sitemap-cohort-auditor ./sitemap.xml --json --with-cohort > release-42.json

# during the next release
sitemap-cohort-auditor ./sitemap.xml --compare ./release-42.json --json
```

Every report always records `cohort.count` and `cohort.digest`, a SHA-256
fingerprint of the sorted unique URLs. If the baseline report has the digest
but not the URL list, the comparison says so rather than reporting zero
movement:

| Baseline | `comparison.evidence` | What you get |
| --- | --- | --- |
| sitemap, or report with `--with-cohort` | `urls` | exact added and removed lists |
| report without `--with-cohort` | `digest-only` | `cohortChanged` only; added and removed are **unknown**, not zero |

A `maxRemovedUrls` policy rule against a digest-only baseline is a configuration
error, not a pass. Unknown evidence never satisfies a threshold.

A report whose `cohort.urls` does not match its own `cohort.digest` is
rejected, so an edited artifact cannot quietly redefine the baseline.

## Machine-readable output

Add `--json` for stable, sorted JSON suitable for CI or release records:

```sh
sitemap-cohort-auditor ./sitemap.xml --json > sitemap-audit.json
```

The report includes:

- traversed document and sitemap-reference counts;
- total and unique page URL counts;
- duplicate URLs and their source sitemap files;
- total and unique `image:loc` counts;
- host and scheme counts across unique, valid HTTP(S) page URLs;
- invalid or non-ISO `<lastmod>` values;
- page URLs containing fragments;
- invalid page URLs and entries missing `<loc>`;
- already-visited sitemap children, including circular references;
- `cohort.count` and `cohort.digest`, plus `cohort.urls` with `--with-cohort`; and
- optionally, sorted added and removed URL cohorts with the evidence they rest on.

Accepted `<lastmod>` formats are `YYYY-MM-DD` and a complete ISO/W3C-style timestamp with seconds and a `Z` or numeric timezone, such as `2026-08-10T12:30:00+05:30`.

## Reproducible release example

[`examples/release/`](./examples/release/) contains a synthetic before/after
sitemap release, a passing policy, and the exact normalized JSON report. Run it
from the repository root:

```sh
node ./bin/sitemap-cohort-auditor.mjs \
  ./examples/release/after/index.xml \
  --compare ./examples/release/before.xml \
  --policy ./examples/release/policy.json \
  --json
```

The example demonstrates a five-URL sitemap graph with two additions, one
removal, two image declarations, and no invalid metadata. A test keeps the
checked-in [`report.json`](./examples/release/report.json) synchronized with the
CLI output.

## Enforce a release policy in CI

Add `--policy` to turn selected sitemap findings into an explicit CI gate:

```sh
sitemap-cohort-auditor ./after/sitemap.xml \
  --compare ./before/sitemap.xml \
  --policy ./sitemap-policy.json
```

Policies are local, versioned JSON files. A strict starting point is included at
[`examples/strict-policy.json`](./examples/strict-policy.json):

```json
{
  "schemaVersion": 1,
  "allowedHosts": ["example.com"],
  "allowedSchemes": ["https"],
  "minUniqueUrls": 1,
  "maxDuplicateUrls": 0,
  "maxInvalidLastmodValues": 0,
  "maxFragmentUrls": 0,
  "maxInvalidUrls": 0,
  "maxMissingLocs": 0,
  "maxRemovedUrls": 0
}
```

Supported rules are:

| Rule | Meaning |
| --- | --- |
| `allowedHosts` | Exact lowercase URL hosts permitted in valid page URLs, including any non-default port |
| `allowedSchemes` | Permitted page URL schemes: `http`, `https`, or both |
| `minUniqueUrls` | Minimum number of unique page URL declarations |
| `minUniqueImages` | Minimum number of unique image URL declarations |
| `maxDuplicateUrls` | Maximum number of page URLs declared more than once |
| `maxDuplicateUrlEntries` | Maximum declarations beyond the unique page URL count |
| `maxInvalidLastmodValues` | Maximum invalid or non-ISO `<lastmod>` values |
| `maxFragmentUrls` | Maximum page URLs containing fragments |
| `maxInvalidUrls` | Maximum malformed or unsupported page URLs |
| `maxMissingLocs` | Maximum sitemap or URL records without a primary `<loc>` |
| `maxRemovedUrls` | Maximum removed URLs; requires `--compare` |

Unknown properties, duplicate allowed values, unsupported schemes, negative
limits, and unrecognized schema versions are rejected. Rules use inclusive
boundaries: a count exactly equal to its minimum or maximum passes. With
`--json`, the deterministic `policy` object is included in the normal report.

Host and scheme allowlists inspect valid HTTP(S) page URLs. If a malformed or
unsupported URL was dropped from that index, those allowlist conclusions are
incomplete even when every indexed host or scheme is allowed. Independent
known violations remain in the report; a partial index never proves a pass.

The policy file is never fetched over the network and is limited to 64 KiB. A
policy gate checks the sitemap declaration supplied to this command; it does
not crawl listed pages or prove that a release is indexed.

A policy file that does not parse is reported by position, line, and column,
never by quoting it back. `JSON.parse` embeds the input in one of its two error
messages, so a policy file short enough to be only a credential would otherwise
be reproduced in full by its own failure — and escaping the diagnostic for the
terminal does not remove it, because a credential is printable.

## Safety limits

- HTTP input is rejected. Remote child sitemaps and redirects must stay on the starting URL's HTTPS origin.
- Local sitemap indexes may reference only local child files; they cannot initiate remote requests.
- Remote redirects are followed manually, with at most five redirects across a request.
- Remote request chains time out after 30 seconds.
- Each sitemap transfer and each uncompressed XML document is streamed with a 50 MiB limit.
- Policy input must be a local UTF-8 JSON file and is streamed with a 64 KiB limit.
- A sitemap graph is limited to 10,000 distinct documents.
- Gzip content is detected from its bytes, so local and remote `.gz` files are supported even when their names are unconventional.
- Human-readable output escapes terminal control and bidirectional formatting characters.

## Architecture

The utility separates source loading and traversal, report finalization,
comparison, policy evaluation, and presentation. Remote fetches cross a strict
same-origin HTTPS boundary; local indexes cannot initiate network access. See
[Architecture and data flow](./docs/architecture.md) for the component map,
trust boundaries, resource limits, and security-sensitive change areas.

## Limitations

This is a focused sitemap checker, not a general XML validator or crawler.

- It reads standard sitemap `<url>`, `<sitemap>`, `<loc>`, `<lastmod>`, and `image:loc` elements with a small, dependency-free extractor. It does not validate arbitrary XML schemas, signatures, or DTDs.
- Image counting expects the conventional `image:loc` prefix.
- It audits sitemap declarations; it does not request every listed page, verify canonical tags, assess page quality, or estimate search rankings.
- Counts describe the sitemap at audit time. A changing remote sitemap can produce different results on later runs.
- A successful audit does not guarantee indexing. Search engines make their own crawling and indexing decisions.
- The byte limit is per document. Very large sitemap graphs can still require substantial aggregate work, so do not expose this CLI as an unauthenticated hosted service.
- Local child paths can traverse directories or resolve through symlinks. Review untrusted local sitemap indexes before running them in a privileged environment.

The expanded [limitations and non-goals](./docs/limitations-and-non-goals.md)
document explains the XML, URL-comparison, remote-origin, resource, and policy
boundaries in detail.

## Exit codes

- `0`: audit completed, even if quality findings were reported;
- `1`: the sitemap could not be loaded or parsed safely;
- `2`: command-line usage or policy-configuration error;
- `3`: the audit completed but one or more configured policy rules failed.

## License

MIT. See [LICENSE](./LICENSE).

## Project links

- [Latest release](https://github.com/edilec/sitemap-cohort-auditor/releases/latest)
- [Security policy](https://github.com/edilec/sitemap-cohort-auditor/security/policy)
- [Private vulnerability report](https://github.com/edilec/sitemap-cohort-auditor/security/advisories/new)
- [Changelog](./CHANGELOG.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Code of conduct](./CODE_OF_CONDUCT.md)
- [Architecture and data flow](./docs/architecture.md)
- [Limitations and non-goals](./docs/limitations-and-non-goals.md)
- [Support](./SUPPORT.md)
- [Maintainers](./MAINTAINERS.md)
- [Release process](./docs/releasing.md)

## Maintainer

Maintained by [Edilec](https://edilec.com/). The companion guide, [Sitemap partitioning for large-site coverage diagnostics](https://edilec.com/blog/proeng-11045/sitemap-partitioning-large-sites-coverage-diagnostics/), explains the release questions this utility is designed to make reviewable.
