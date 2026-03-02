# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-03-02

### Added
- Fastify + TypeScript core service
- File upload/download share links
- Preview page for shared files
- Optional expiration and optional max download count
- Admin management UI (list/delete/batch-delete)
- Storage stats and service version endpoints
- Admin session auth and password-based API auth
- Expired-record cleanup task
- Docker and docker-compose deployment files
- Nginx reverse proxy example

### Fixed
- Large file truncation caused by default body limits
- Expiration unit handling and UI rendering issues
- Multiple security and robustness audit findings
