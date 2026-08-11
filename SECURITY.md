# Security policy

## Supported versions

Security fixes are applied to the latest release on the main development branch. Older releases may not receive backports.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through the repository host's private security-reporting feature or another private channel published by the maintainers. Do not include secrets, personal data, or third-party data in a report.

Include the affected version, operating system and Node.js version, reproduction steps, expected behavior, and observed impact. Maintainers will acknowledge the report when it is received and will coordinate disclosure after a fix is available.

## Scope notes

The utility reads local files and retrieves user-supplied HTTPS sitemap URLs. Treat untrusted sitemap files as untrusted input, run the CLI with the least filesystem access it needs, and review URLs before using them in another automated workflow.
