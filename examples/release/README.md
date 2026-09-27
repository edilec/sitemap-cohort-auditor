# Release comparison example

This synthetic example models a release that adds two pages, removes one legacy
page, and preserves four URLs from the previous cohort. It contains no
production or customer data.

From the repository root, run:

```sh
node ./bin/sitemap-cohort-auditor.mjs \
  ./examples/release/after/index.xml \
  --root ./examples/release \
  --compare ./examples/release/before.xml \
  --policy ./examples/release/policy.json \
  --json
```

The checked-in [`report.json`](./report.json) is generated from those inputs.
Its document and URL references are safe ordinals, not local paths or raw URL
strings. A test regenerates and compares it so the example cannot drift from
the CLI schema or fixtures unnoticed.

Expected result:

- five unique URLs in the new sitemap graph;
- two new URLs and one removed URL;
- two unique image declarations;
- no duplicates, invalid dates, fragments, invalid URLs, or missing locations;
- a passing policy result; and
- process exit code `0`.
