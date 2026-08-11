# Contributing

Contributions that make sitemap audits more accurate, predictable, or easier to review are welcome.

## Development setup

1. Install Node.js 20 or newer.
2. Run `npm install` from this directory. The project has no runtime dependencies.
3. Run `npm test` before submitting a change.

## Change guidelines

- Keep the runtime dependency-free unless there is a compelling, documented reason to change that policy.
- Add or update `node:test` coverage for behavior changes.
- Use small, synthetic fixtures. Do not commit private customer URLs, credentials, analytics exports, or production data.
- Preserve deterministic ordering in JSON output.
- Document any new network access, filesystem behavior, limits, or output fields.
- Avoid claims about indexing or ranking outcomes; this tool reports sitemap evidence only.

## Pull requests

Describe the problem, the chosen behavior, tests run, and any compatibility impact. Keep unrelated formatting or refactoring out of the same change when possible.

By contributing, you agree that your contribution is licensed under the MIT License included in this project.
