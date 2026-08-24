# Limitations and non-goals

Sitemap Cohort Auditor answers a narrow question: what does a sitemap declare,
and how did that declared URL cohort change? These boundaries are intentional.

## It is not a crawler

The utility does not request page URLs listed in a sitemap. It does not verify:

- page HTTP status, redirects, rendering, content, or canonical tags;
- `robots.txt`, robots metadata, authentication, or crawl accessibility;
- search-engine discovery, indexing, ranking, traffic, or search performance;
- hreflang, video, news, alternate-language, or arbitrary extension schemas; or
- consistency between a sitemap and an analytics or search-console export.

A passing report proves only that the inspected declaration met the configured
checks at the time of the audit.

## It is not a general XML validator

The dependency-free extractor recognizes the sitemap elements needed by the
report. It does not validate against an XML schema, reject every malformed XML
construct, process DTDs, expand custom entities, verify signatures, or preserve
arbitrary namespaces. Image counting expects the conventional `image:loc`
prefix.

Use a standards-compliant XML validator as a separate check when full XML
conformance is a release requirement.

## URL comparison is exact

After XML text decoding and trimming, URL cohorts are compared as exact
strings. The utility does not treat these as equivalent:

- HTTP and HTTPS;
- hosts with and without `www`;
- paths with and without a trailing slash;
- reordered or differently encoded query strings; or
- aliases that redirect to the same page.

This is useful for detecting declaration drift, but it is not URL
canonicalization.

## Remote traversal is deliberately constrained

Remote child sitemaps and redirects must remain on the starting URL's exact
HTTPS origin. Distributed sitemap estates that intentionally place child files
on another origin must audit those origins separately. Automatic content
encoding is rejected because the utility applies its own bounded gzip handling.

## Resource bounds are per document

The 50 MiB transfer and decoded-size limits apply to each document. A graph can
contain up to 10,000 documents, so aggregate network use and processing time can
still be substantial. Do not expose this command as an unauthenticated hosted
service. A decoded document is held in memory during extraction.

## Local input inherits local filesystem risk

Local child references can traverse directories or resolve through symlinks.
Do not run an untrusted local sitemap index with broad filesystem permissions.

## Policy is a release gate, not a prediction

Policy rules evaluate counts and exact allowlists already present in the audit
report. They do not learn baselines, infer intent, contact a search engine, or
predict business outcomes.
