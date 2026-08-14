# Changelog

All notable changes to Sitemap Cohort Auditor are documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/edilec/sitemap-cohort-auditor/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/edilec/sitemap-cohort-auditor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/edilec/sitemap-cohort-auditor/releases/tag/v0.1.0
