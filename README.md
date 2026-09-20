# Sitemap Cohort Auditor

[![CI](https://github.com/edilec/sitemap-cohort-auditor/actions/workflows/ci.yml/badge.svg)](https://github.com/edilec/sitemap-cohort-auditor/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/edilec/sitemap-cohort-auditor?label=release)](https://github.com/edilec/sitemap-cohort-auditor/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-555.svg)](./LICENSE)
[![Security policy](https://img.shields.io/badge/security-policy-555.svg)](https://github.com/edilec/sitemap-cohort-auditor/security/policy)

A dependency-free Node.js command-line utility for checking sitemap cohorts before and after a site release. It follows nested sitemap indexes, counts page and image entries, and highlights changes or metadata problems that are easy to miss in very large sitemaps.

**Status:** maintained. The supported runtime is Node.js 20 or newer; CI covers
Node.js 20, 22, and 24. Reports use schema version `2`; release-policy files use
schema version `1`.

## Requirements

- Node.js 20 or newer
- A local sitemap XML/XML.GZ export

The utility uses only Node built-ins and never makes a network request. It
does not send results to a service or require an API key.

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

Export a sitemap to a local file before auditing. URL inputs and network
fetch callbacks are not supported. The default read root is the real parent
directory of the initial sitemap. Use `--root DIRECTORY` only when an exported
index, comparison sitemap or baseline report legitimately spans sibling
directories. The initial file and every child must resolve inside that root.

## Compare two URL cohorts

Use the current sitemap as the main argument and the older sitemap after `--compare`:

```sh
sitemap-cohort-auditor ./after/sitemap.xml --root . --compare ./before/sitemap.xml
```

The comparison uses exact, decoded `<loc>` strings from unique URL entries.
Default reports give added/removed counts and safe current/baseline URL
ordinals, not raw URL strings. Invalid URL strings remain in the internal
comparison so malformed entries cannot silently disappear from review.

### Compare against an earlier report

After a release the previous sitemap is usually gone, but the audit artifact
you stored is not. `--compare` also accepts an earlier `--json` report from
this tool, so a CI job can compare each release against the one before it
without keeping old sitemaps around.

A report only carries its URL list when it was produced with `--with-cohort`:

`--with-cohort` deliberately writes the complete exact URL list as a local
baseline artifact. URLs may contain private paths or query values; store that
artifact with appropriate access controls. Default reports expose only
counts, ordinals and fixed source labels. Do not treat an ordinal as the URL
itself.

```sh
# during the release that is about to become "before"
sitemap-cohort-auditor ./sitemap.xml --json --with-cohort > release-42.json

# during the next release
sitemap-cohort-auditor ./sitemap.xml --compare ./release-42.json --json
```

Every report always records `cohort.count`, `cohort.digestAlgorithm`, and
`cohort.digest`. Version 2 fingerprints the sorted unique URLs with a
length-framed UTF-16LE SHA-256 input, so an embedded newline cannot make one
URL hash like two entries. If the baseline report has the digest
but not the URL list, the comparison says so rather than reporting zero
movement:

| Baseline | `comparison.evidence` | What you get |
| --- | --- | --- |
| sitemap, or report with `--with-cohort` | `urls` | exact internal comparison; added and removed counts with safe ordinals |
| report without `--with-cohort` | `digest-only` | `cohortChanged` only; added and removed are **unknown**, so the run is incomplete (exit `2`) |
| legacy version 1 report with its full unique URL list | `urls` | validated against its legacy digest, then compared with version 2 framing |
| legacy version 1 digest-only report | `legacy-digest-only` | incomplete: the old unframed digest cannot prove version 2 cohort equality |

A `maxRemovedUrls` policy rule against a digest-only baseline is incomplete,
not a pass. Unknown evidence never satisfies a threshold.

A report whose count, sorted unique URL list, digest shape or algorithm is
inconsistent is rejected, as is JSON with duplicate keys. An edited artifact
cannot quietly redefine the baseline.

## Machine-readable output

Add `--json` for stable, sorted JSON suitable for CI or release records:

```sh
sitemap-cohort-auditor ./sitemap.xml --json > sitemap-audit.json
```

The report includes:

- the house envelope (`tool`, `status`, `summary.checked/errors/warnings`,
  `findings`); `checked` counts fully audited local sitemap documents, not
  declarations inferred from missing or unsupported evidence;
- traversed document and sitemap-reference counts;
- total and unique page URL counts;
- duplicate URL counts with URL/document ordinals;
- total and unique `image:loc` counts;
- host ordinals and scheme counts across unique, valid HTTP(S) page URLs;
- invalid or non-ISO `<lastmod>` values;
- page URLs containing fragments;
- invalid page URLs and entries missing `<loc>`;
- already-visited sitemap children, including circular references;
- `cohort.count` and `cohort.digest`, plus `cohort.urls` with `--with-cohort`; and
- optionally, added and removed counts with current/baseline URL ordinals and
  the evidence they rest on.

`findings` use fixed source labels (`current`, `baseline`, `policy`) and
array-position pointers, sorted by UTF-16 code units. They never include
arbitrary URL, filename or policy values. The following emitted rules have
stable severity:

| Finding rule | Severity | Evidence |
| --- | --- | --- |
| `duplicate-url`, `url-fragment`, `invalid-url`, `lastmod-invalid`, `loc-missing` | warning | A known sitemap quality observation |
| `cohort-movement-unknown`, `policy-evidence-incomplete` | warning | Comparison or configured policy lacks sufficient evidence; overall status incomplete |
| `policy-*` | error | A configured policy rule definitely failed |
| `input-unreadable`, `input-invalid` | warning | An input document could not be evaluated; overall status incomplete |
| `timeout-exceeded`, `clock-invalid` | warning | The monotone deadline or injected clock prevents a complete run; overall status incomplete |

Accepted `<lastmod>` formats are `YYYY-MM-DD` and a complete ISO/W3C-style timestamp with seconds and a `Z` or numeric timezone, such as `2026-08-10T12:30:00+05:30`.

## Reproducible release example

[`examples/release/`](./examples/release/) contains a synthetic before/after
sitemap release, a passing policy, and the exact normalized JSON report. Run it
from the repository root:

```sh
node ./bin/sitemap-cohort-auditor.mjs \
  ./examples/release/after/index.xml \
  --root ./examples/release \
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
sitemap-cohort-auditor ./after/sitemap.xml --root . \
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

- All sitemap and comparison inputs are local exports. Remote roots, children,
  fetch callbacks and redirect options are unsupported; no network is opened.
- The initial file, local children and comparison input must resolve inside
  the real read root. Out-of-root symlinks make the run incomplete.
- Each local sitemap file and each uncompressed XML document is streamed with a 50 MiB limit.
- Policy input must be a local UTF-8 JSON file and is streamed with a 64 KiB limit.
- A sitemap graph is limited to 10,000 distinct documents.
- The analysis deadline defaults to 30,000 ms and can be set with
  `--timeout-ms N` from `0` through `60000`. The library accepts `timeoutMs`
  and an injected monotone `now` function for deterministic tests. Exactly N
  elapsed milliseconds remains within the bound; N+1 is incomplete. A timeout
  returns only source-positioned observations already seen and counts only
  fully parsed documents as `checked`; it does not publish a partial cohort or
  claim missing data is absent. Baseline timeouts retain the already complete
  current audit. A malformed or throwing clock also produces an incomplete
  report without echoing the clock error. Checks occur around stream chunks,
  parser records and graph steps; a single synchronous built-in operation
  cannot be preempted, so wall-clock overshoot can vary under load.
- Gzip content is detected from its bytes, so local `.gz` files work even when their names are unconventional.
- Human-readable output escapes terminal control and bidirectional formatting characters.

## Architecture

The utility separates source loading and traversal, report finalization,
comparison, policy evaluation, and presentation. The source loader has no
network branch and confines local reads to the declared root. See
[Architecture and data flow](./docs/architecture.md) for the component map,
trust boundaries, resource limits, and security-sensitive change areas.

## Limitations

This is a focused sitemap checker, not a general XML validator or crawler.

- It reads standard sitemap `<url>`, `<sitemap>`, `<loc>`, `<lastmod>`, and `image:loc` elements with a small, dependency-free extractor. It does not validate arbitrary XML schemas, signatures, or DTDs.
- Image counting expects the conventional `image:loc` prefix.
- It audits sitemap declarations; it does not request every listed page, verify canonical tags, assess page quality, or estimate search rankings.
- Counts describe the exported sitemap at audit time, not a live site.
- A successful audit does not guarantee indexing. Search engines make their own crawling and indexing decisions.
- The byte limit is per document. Very large sitemap graphs can still require substantial aggregate work, so do not expose this CLI as an unauthenticated hosted service.
- An out-of-root child path or symlink is refused as incomplete; the tool does
  not prove that an exported sitemap was a complete snapshot of a live site.

The expanded [limitations and non-goals](./docs/limitations-and-non-goals.md)
document explains the XML, URL-comparison, local-root, resource, and policy
boundaries in detail.

## Exit codes

- `0`: complete evidence and no configured policy violation;
- `1`: a configured policy rule definitely failed on complete evidence;
- `2`: incomplete evidence, including unreadable or malformed local input, or
  invalid command-line/policy configuration. Input problems emit a JSON or
  human report with `status: incomplete`; configuration errors leave stdout
  empty.

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
