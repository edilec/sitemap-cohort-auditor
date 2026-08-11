## Summary

Describe the user-visible or maintainer-visible change.

## Why

Explain the release-review problem this solves and why it belongs in this focused sitemap auditor.

## Validation

- [ ] `npm test`
- [ ] `npm pack --dry-run`
- [ ] New or changed behavior has focused tests
- [ ] Documentation and examples match the implementation

## Safety and compatibility

- [ ] No secrets, personal data or confidential third-party URLs are included
- [ ] Remote-input restrictions and streaming limits are preserved or intentionally reviewed
- [ ] Text and JSON output remain deterministic and terminal-safe
- [ ] Node.js 20 and 24 compatibility is preserved
