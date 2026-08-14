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

## Scope notes

The utility reads local files and retrieves user-supplied HTTPS sitemap URLs. An optional policy gate reads a local JSON file. Treat sitemap and policy files as untrusted input, run the CLI with the least filesystem access it needs, and review URLs before using them in another automated workflow.
