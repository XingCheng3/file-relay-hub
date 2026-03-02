# Release Checklist

## Pre-release

- [ ] `npm ci && npm run build` passes
- [ ] README/API docs reflect current behavior
- [ ] Secret scan completed (no credentials in tracked files)
- [ ] Docker compose boot smoke test passed
- [ ] CHANGELOG updated

## Tag & GitHub Release

```bash
git tag -a v0.1.0 -m "release: v0.1.0"
git push origin v0.1.0
```

Then create a GitHub Release from tag `v0.1.0` and paste highlights from `CHANGELOG.md`.

## Post-release

- [ ] Verify CI status on `main`
- [ ] Verify public README badges and links
- [ ] Smoke test upload/download on production URL
