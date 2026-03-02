# file-relay-hub

[![GitHub stars](https://img.shields.io/github/stars/XingCheng3/file-relay-hub?style=social)](https://github.com/XingCheng3/file-relay-hub/stargazers)
[![CI](https://github.com/XingCheng3/file-relay-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/XingCheng3/file-relay-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A lightweight **file relay service** for temporary file sharing.

Upload a file, get a shareable link, download anywhere. Includes admin-protected management UI, optional expiration, download limits, and disk safety guardrails.

---

## ✨ Features

- Upload files via Web UI or API
- Generate shareable links:
  - Download link: `/f/:token`
  - Preview/share page: `/s/:token`
- Optional expiration:
  - Hour/day unit in UI
  - Empty = never expire
- Optional max download count
- Admin-protected management:
  - File list (available/unexpired)
  - Single delete / batch delete
  - Manual cleanup of expired records
  - Storage stats (total/used/available)
  - Service version display
- Disk safety guard:
  - Keep at least **5GB free** after upload
- Public share links stay accessible without admin login (`/f/*`, `/s/*`)

---

## 🧱 Tech Stack

- Node.js + TypeScript
- Fastify
- `@fastify/multipart` (upload)
- `@fastify/static` (UI assets)
- Local disk storage (`data/uploads`) + JSON metadata (`data/relay-meta.json`)

---

## 🚀 Quick Start

```bash
git clone https://github.com/XingCheng3/file-relay-hub.git
cd file-relay-hub
npm install
```

### 1) Configure env

```bash
cp .env.example .env
# edit .env, especially ADMIN_PASSWORD
```

### 2) Run

```bash
npm run dev
```

Open: `http://127.0.0.1:3000/`

---

## ⚙️ Environment Variables

| Name | Required | Default | Description |
|---|---|---:|---|
| `HOST` | No | `0.0.0.0` | Bind host |
| `PORT` | No | `3000` | Service port |
| `ADMIN_PASSWORD` | **Yes** | - | Admin access password (required at startup) |
| `ADMIN_SESSION_TTL_HOURS` | No | `12` | Admin session lifetime |
| `ADMIN_SESSION_SECRET` | No | derived | Cookie signing secret (set explicitly in production) |
| `CLEANUP_INTERVAL_MINUTES` | No | `10` | Interval for expired-record cleanup task |

> If `ADMIN_PASSWORD` is missing, server exits intentionally.

---

## 📦 Upload Limits & Throughput

- No application-level file type restriction
- No application-level rate throttling
- Application-level request/file limit set to **20GB**
- Upload will be rejected if free space would drop below **5GB**
- If behind reverse proxy (Nginx/Caddy), proxy limits (e.g. `client_max_body_size`) may still apply

---

## 🔌 API Overview

### Public

- `GET /health`
- `GET /f/:token` (download)
- `GET /f/:token/info`
- `GET /s/:token` (preview page)

### Admin-protected

- `GET /` / `GET /index.html`
- `POST /upload` (multipart)
- `POST /admin/login`
- `POST /admin/logout`
- `GET /admin/files`
- `DELETE /admin/files/:token`
- `DELETE /admin/files` (batch)
- `POST /admin/cleanup-expired`
- `GET /admin/storage`
- `GET /admin/version`

See detailed examples in: **[docs/API.md](./docs/API.md)**

---

## 📁 Storage Layout

- Uploaded files: `data/uploads/`
- Metadata: `data/relay-meta.json`

Both paths are relative to project root.

---

## 🐳 Docker Deployment

```bash
docker compose up -d --build
```

Default compose maps:
- Port: `3000:3000`
- Data volume: `./data:/app/data`

Nginx example config: `nginx/file-relay-hub.conf.example`

---

## 🔐 Security Notes

- Never commit real passwords/tokens
- Set `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` in environment (not in code)
- Use HTTPS in production
- Put service behind reverse proxy with request logging and optional WAF/rate-limit
- Rotate credentials if leaked

---

## 🧪 Development Scripts

```bash
npm run dev
npm run build
npm start
```

---

## 🗺️ Roadmap

- [ ] Optional object storage backend (S3/MinIO)
- [ ] Pluggable auth providers
- [ ] Rate limiting / abuse controls
- [ ] Better observability and metrics

---

## 🤝 Contributing

PRs and issues are welcome.

Please read: **[CONTRIBUTING.md](./CONTRIBUTING.md)**

---

## 📄 License

MIT
