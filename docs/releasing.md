# Releasing

Releases are created from an existing reviewed version tag through the manually
dispatched `Release` workflow. The workflow does not create or move tags.

## One-time repository setup

Before using the workflow, configure a GitHub Actions environment named
`release` with required reviewers. Keep release permissions limited to the
maintainers listed in [MAINTAINERS.md](../MAINTAINERS.md).

Protect tags matching `v*` against deletion, update, and creation by identities
outside the release-maintainer group. Require the normal CI checks on `main`.

## Prepare a release

1. Complete and merge the substantive change through review.
2. Set the intended version in `package.json` and `lib/audit.mjs`.
3. Move the relevant entries from `Unreleased` into a dated changelog section.
4. Run `npm run verify` from a clean checkout.
5. Create a signed or verified annotated tag named `v<package version>` from the
   reviewed commit and push that tag.
6. Manually dispatch the `Release` workflow with that exact existing tag.
7. Approve the protected `release` environment only after the verification job
   passes and its package contents have been reviewed.

The workflow checks that the input tag, checked-out tag, package version, and
dated changelog entry agree. It runs the full project verification, records the
verified source commit, creates the package and SHA-256 checksum, re-resolves the
tag immediately before publication, transfers only those verified artifacts
into the write-enabled job, and refuses to replace an existing release.

## After publication

- Install the package from the release URL in a clean temporary environment.
- Verify the published checksum.
- Run `sitemap-cohort-auditor --version`.
- Confirm generated release notes and asset links.
- Announce only behavior and compatibility that were verified for that release.

Do not publish a release solely to create profile activity.
