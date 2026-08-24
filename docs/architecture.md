# Architecture and data flow

Sitemap Cohort Auditor is a dependency-free Node.js command-line application.
Its design favors bounded input, deterministic evidence, and explicit trust
boundaries over broad crawling behavior.

## Components

| Component | Responsibility |
| --- | --- |
| `bin/sitemap-cohort-auditor.mjs` | Parse CLI arguments, select text or JSON output, apply a policy, and map failures to exit codes. |
| `lib/audit.mjs` | Normalize sources, load and decode documents, traverse sitemap indexes, collect findings, compare cohorts, and format reports. |
| `lib/policy.mjs` | Parse a bounded local policy, validate its schema, evaluate report thresholds, and format policy findings. |

## Data flow

```mermaid
flowchart LR
    A[CLI arguments] --> B{Source kind}
    B -->|Local path or file URL| C[Bounded file stream]
    B -->|HTTPS URL| D[Manual same-origin fetch and redirects]
    C --> E[Magic-byte gzip detection]
    D --> E
    E --> F[Bounded UTF-8 document]
    F --> G[Root and element extraction]
    G -->|sitemapindex| H[Resolve and visit child]
    H --> B
    G -->|urlset| I[Collect URL, image, and lastmod evidence]
    I --> J[Sort and finalize report]
    J --> K{Comparison supplied?}
    K -->|Yes| L[Exact URL cohort difference]
    K -->|No| M[Report]
    L --> M
    N[Local policy JSON] --> O[Bounded schema validation]
    O --> P[Policy evaluation]
    M --> P
    M --> Q[Text or deterministic JSON]
    P --> Q
```

Traversal is depth-first. A visited-source set prevents repeat processing and
reports circular or duplicate child references. Reports are sorted before
serialization so the same stable inputs produce the same output.

## Trust boundaries

### Local files

Local sitemap indexes may reference only local children. Relative paths are
resolved from the parent document, and `file:` children are supported. Local
paths may traverse directories or follow symlinks, so untrusted indexes should
run with the least filesystem access available.

### Remote input

Remote roots must use credential-free HTTPS URLs. Every child and redirect must
remain on the root's exact origin and use HTTPS. Redirects are handled manually
to validate the next target before a request is sent. HTTP input, cross-origin
children, embedded credentials, automatic redirects, and non-identity content
encoding are rejected.

### Resource bounds

- Each transfer and each uncompressed XML document is limited to 50 MiB.
- Redirects are limited to five per request chain.
- Remote request chains time out after 30 seconds.
- A sitemap graph is limited to 10,000 distinct documents.
- Local policy input is limited to 64 KiB.

The input stream is bounded before and after optional gzip decompression. A
single decoded document is held in memory for extraction; the whole graph is
not retained as raw XML.

## Parsing model

The extractor recognizes the sitemap elements required by the report:
`urlset`, `sitemapindex`, `url`, `sitemap`, `loc`, `lastmod`, and `image:loc`.
It decodes common XML entities and numeric character references, trims element
text, and does not execute DTDs or expand custom entities.

This deliberately small extractor is not an XML-schema validator. Its boundary
is documented in [Limitations and non-goals](./limitations-and-non-goals.md).

## Comparison and policy

Cohort comparison uses exact decoded `<loc>` strings. It does not normalize
trailing slashes, case, query ordering, host aliases, or default documents.
Malformed entries remain visible in the cohort instead of silently dropping
out.

Policy evaluation happens after a successful audit. A failing policy still
emits the complete report and exits with code `3`; loading or parsing failures
use different exit codes. Policies are local, versioned JSON and cannot trigger
network access.

## Security-sensitive changes

Changes to source normalization, redirects, streaming bounds, decompression,
terminal escaping, policy parsing, or output ordering require focused tests and
maintainer review. See [SECURITY.md](../SECURITY.md) for private reporting.
