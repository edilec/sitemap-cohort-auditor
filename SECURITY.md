# Security policy

## Supported versions

Security fixes are applied to the latest release on the main development branch. Older releases do not receive backports unless the maintainers explicitly announce otherwise.

| Version | Supported |
| --- | --- |
| 0.2.x | Yes |
| 0.1.1 | No |
| 0.1.0 | No |

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting form](https://github.com/edilec/sitemap-cohort-auditor/security/advisories/new) for suspected security issues. Do not open a public issue for an undisclosed vulnerability, and do not include secrets, personal data, or third-party data in a report.

Include the affected version, operating system and Node.js version, reproduction steps, expected behavior, and observed impact. Maintainers will acknowledge the report when it is received and will coordinate disclosure after a fix is available.

Do not send a production sitemap, customer URL inventory, credential, private
hostname, or access token unless a maintainer specifically requests a reduced
and sanitized example through the private advisory. A synthetic fixture is
usually enough to reproduce parser and traversal behavior.

## Scope notes

The utility reads local sitemap exports and an optional local JSON policy; it
never retrieves URLs. Treat exported files as untrusted input, run the CLI with
the least filesystem access it needs, and review URLs before using them in
another automated workflow.

The trust boundaries and deliberate restrictions are described in
[Architecture and data flow](./docs/architecture.md). Known non-goals are
documented in [Limitations and non-goals](./docs/limitations-and-non-goals.md).
