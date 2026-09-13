# Changelog

All notable changes to Sitemap Cohort Auditor are documented here.

The project follows [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- `--compare` accepts an earlier `--json` report from this tool, not only an
  older sitemap. After a release the previous sitemap is usually gone while the
  stored audit artifact is not.
- every report records `cohort.count` and `cohort.digest`, a SHA-256
  fingerprint over the sorted unique URLs, so a baseline can prove whether the
  cohort changed.
- `--with-cohort` includes `cohort.urls` in the JSON report so a later run can
  recover exactly which URLs moved.
- `comparison.evidence` distinguishes `urls` from `digest-only`, alongside
  `cohortChanged`, `previousCohortDigest`, and `baselineKind`.
- exported `cohortDigest`.

### Fixed

- findings, duplicate lists, host and scheme counts, and cohort URLs are now
  ordered by UTF-16 code unit rather than by locale. `localeCompare` depends on
  ICU data that varies between Node builds and platforms, so the same sitemap
  could produce differently ordered output on two correct machines and a release
  comparison diffing those reports would see changes that are not there.
  This changes one observable order: `MAX_DUPLICATE_URLS` now precedes
  `MAX_DUPLICATE_URL_ENTRIES`, because `S` sorts before `_` by code point while
  locale collation treats the underscore as ignorable punctuation. The checked-in
  release fixture is unaffected.

### Changed

- a digest-only baseline reports added and removed URLs as unknown instead of
  zero, and a `maxRemovedUrls` policy rule against one is rejected as a
  configuration error rather than evaluated as compliance.
- a comparison report whose `cohort.urls` disagrees with its own
  `cohort.digest` is rejected.

## [Unreleased]

## [0.2.2] - 2026-08-26

### Security

- Replaced regex-based scalar markup removal with explicit CDATA handling and
  rejection of nested markup in sitemap scalar fields.
- Restricted XML declaration and comment handling to a validated leading
  preamble so embedded or malformed markers cannot influence root detection.

## [0.2.1] - 2026-08-24

### Added

- Added a reproducible before/after release example with a checked-in JSON report.
- Added architecture, data-flow, support, maintenance, and expanded non-goal documentation.
- Added a local documentation-link check, Node.js 22 CI coverage, and built-in coverage evidence.
- Added a manually dispatched, approval-ready release workflow with version and tag validation.
- Added repository social-preview artwork with an editable SVG source.

## [0.2.0] - 2026-08-14

### Added

- Added an opt-in, versioned JSON policy gate for CI and release checks.
- Added exact host and scheme allowlists, URL and image minimums, quality-signal maximums, and a removed-URL limit for cohort comparisons.
- Added deterministic structured policy findings and exit code `3` when a policy fails after a successful audit.
- Added a bounded strict-policy example and tests for validation, thresholds, output stability, exit behavior, and local-file safety.

### Security

- Restricted policy input to local UTF-8 JSON files with a 64 KiB streamed limit.
- Rejected unknown properties, accessors, symbol keys, duplicate normalized allowlist values, and unsupported policy versions.

## [0.1.1] - 2026-08-11

### Security

- Restricted remote child sitemaps and redirects to credential-free, same-origin HTTPS URLs.
- Added manual redirect handling with loop detection, a five-hop limit, and target validation before requests.
- Prevented local sitemap indexes from initiating remote requests.
- Enforced bounded transfer and decompressed XML sizes, including streamed Gzip input.
- Escaped terminal control and bidirectional formatting characters in human-readable output.

### Changed

- Pinned the CI actions used for checkout and Node.js setup to exact release commits.

## [0.1.0] - 2026-08-11

### Added

- Added a dependency-free Node.js CLI for local and remote sitemap input.
- Added nested sitemap-index traversal and XML/XML.GZ support.
- Added deterministic JSON output for page URLs, image entries, hosts, schemes, last-modified values, fragments, invalid URLs, and duplicate declarations.
- Added exact URL-cohort comparison between two sitemap graphs.

### Security

- This initial release should not be used with untrusted remote sitemaps. Use version 0.1.1 or newer.

[Unreleased]: https://github.com/edilec/sitemap-cohort-auditor/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/edilec/sitemap-cohort-auditor/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/edilec/sitemap-cohort-auditor/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/edilec/sitemap-cohort-auditor/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/edilec/sitemap-cohort-auditor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/edilec/sitemap-cohort-auditor/releases/tag/v0.1.0
