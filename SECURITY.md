# Security Policy

## Supported Versions

Currently supported: `0.1.x`

## Reporting a Vulnerability

Please report vulnerabilities privately to maintainers.
Do not disclose sensitive issues in public issues first.

## Security Recommendations for Deployers

- Set strong `ADMIN_PASSWORD`
- Set explicit `ADMIN_SESSION_SECRET`
- Run behind HTTPS reverse proxy
- Configure proxy upload limits intentionally
- Rotate secrets if leakage is suspected
