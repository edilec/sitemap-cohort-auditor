# Changelog

All notable changes to Sitemap Cohort Auditor are documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/edilec/sitemap-cohort-auditor/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/edilec/sitemap-cohort-auditor/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/edilec/sitemap-cohort-auditor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/edilec/sitemap-cohort-auditor/releases/tag/v0.1.0
