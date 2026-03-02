# API Reference

Base URL: `http://<host>:<port>`

## Authentication

Admin routes require either:

1. Login cookie from `POST /admin/login`
2. Header: `x-admin-password: <ADMIN_PASSWORD>`

Public routes (`/f/*`, `/s/*`, `/health`) do not require auth.

---

## Public Routes

### GET /health
Returns service health.

### GET /f/:token
Download file.

### GET /f/:token/info
Get file metadata.

### GET /s/:token
Preview/share page.

---

## Admin Routes

### POST /admin/login

Request:
```json
{ "password": "..." }
```

Response:
```json
{ "ok": true }
```

### POST /admin/logout
Clear admin session cookie.

### POST /upload
Multipart form-data fields:
- `file` (required)
- `expiresInHours` (optional)
- `expiresValue` + `expiresUnit` (`hour` or `day`) (optional)
- `maxDownloads` (optional)

Response:
```json
{
  "token": "...",
  "downloadUrl": "http://.../f/...",
  "previewUrl": "http://.../s/...",
  "expiresAt": null,
  "maxDownloads": null
}
```

### GET /admin/files
List available (non-expired) files.

### DELETE /admin/files/:token
Delete one file.

### DELETE /admin/files
Batch delete.

Request:
```json
{ "tokens": ["tokenA", "tokenB"] }
```

### POST /admin/cleanup-expired
Trigger cleanup job.

### GET /admin/storage
Disk stats (upload partition).

### GET /admin/version
Service version information.
