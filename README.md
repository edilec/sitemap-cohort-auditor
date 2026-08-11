# Sitemap Cohort Auditor

A dependency-free Node.js command-line utility for checking sitemap cohorts before and after a site release. It follows nested sitemap indexes, counts page and image entries, and highlights changes or metadata problems that are easy to miss in very large sitemaps.

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
- already-visited sitemap children, including circular references; and
- optionally, sorted added and removed URL cohorts.

Accepted `<lastmod>` formats are `YYYY-MM-DD` and a complete ISO/W3C-style timestamp with seconds and a `Z` or numeric timezone, such as `2026-08-10T12:30:00+05:30`.

## Safety limits

- HTTP input is rejected; remote sources and redirects must remain on HTTPS.
- Remote requests time out after 30 seconds.
- Each uncompressed XML document is limited to 50 MiB.
- A sitemap graph is limited to 10,000 distinct documents.
- Gzip content is detected from its bytes, so local and remote `.gz` files are supported even when their names are unconventional.

## Limitations

This is a focused sitemap checker, not a general XML validator or crawler.

- It reads standard sitemap `<url>`, `<sitemap>`, `<loc>`, `<lastmod>`, and `image:loc` elements with a small, dependency-free extractor. It does not validate arbitrary XML schemas, signatures, or DTDs.
- Image counting expects the conventional `image:loc` prefix.
- It audits sitemap declarations; it does not request every listed page, verify canonical tags, assess page quality, or estimate search rankings.
- Counts describe the sitemap at audit time. A changing remote sitemap can produce different results on later runs.
- A successful audit does not guarantee indexing. Search engines make their own crawling and indexing decisions.

## Exit codes

- `0`: audit completed, even if quality findings were reported;
- `1`: the sitemap could not be loaded or parsed safely;
- `2`: command-line usage error.

## License

MIT. See [LICENSE](./LICENSE).

## Maintainer

Maintained by [Edilec](https://edilec.com/). The companion guide, [Sitemap partitioning for large-site coverage diagnostics](https://edilec.com/blog/proeng-11045/sitemap-partitioning-large-sites-coverage-diagnostics/), explains the release questions this utility is designed to make reviewable.
