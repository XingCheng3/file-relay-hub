# Contributing

Thanks for your interest in contributing to file-relay-hub.

## Development setup

```bash
git clone https://github.com/XingCheng3/file-relay-hub.git
cd file-relay-hub
npm install
cp .env.example .env
# set ADMIN_PASSWORD in .env
npm run dev
```

## Before opening a PR

- Run `npm run build` and ensure it passes
- Keep changes focused and minimal
- Update `README.md` / `docs/API.md` when behavior or API changes
- Never commit secrets (passwords, tokens, private keys)

## Commit style (recommended)

- `feat: ...`
- `fix: ...`
- `chore: ...`
- `docs: ...`

## Reporting security issues

Please do not open public issue for sensitive vulnerabilities.
Use private disclosure to repository maintainers.
