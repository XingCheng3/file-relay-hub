# file-relay-hub

临时文件中转服务（Node.js + TypeScript + Fastify）。

## 功能（MVP）

- 上传文件（multipart）
- 生成可分享下载链接
- 分享预览页（`/s/:token`）
- 可选过期时间：
  - 支持按「小时 / 天」设置
  - 留空表示永久链接（不过期）
- 可选最大下载次数（到达后链接失效）
- 本地磁盘存储（`data/uploads`）
- 管理接口（密码保护）：
  - 获取“未过期可用文件清单”（字段：`createdAt` / `expiresAt` / `downloadCount` / `maxDownloads`）
  - 查询上传目录所在分区磁盘空间（总量/已使用/可用）
  - 查询当前服务版本（用于确认前端是否最新）
  - 手动清理已过期记录
  - 单文件删除
  - 批量删除
- 访问控制：
  - `GET /`、`GET /index.html`、`POST /upload`、`/admin/*` 统一后端鉴权
  - 支持 `x-admin-password` 请求头（API 场景）
  - 支持登录后 HttpOnly 会话 Cookie（Web UI 场景）
  - 分享下载链接（`/f/:token`、`/s/:token`）保持公开
- 磁盘保护策略：上传后仍至少保留 5GB 可用空间（否则拒绝/回滚上传）
- 上传链路不做应用层限速、不限制文件类型；应用层默认单文件上限 20GB（并保留 5GB 可用空间策略）

## 快速开始

```bash
npm install
npm run dev
```

默认监听：`http://0.0.0.0:3000`

浏览器访问 `http://<host>:3000/` 可使用 Web UI 上传文件、查看共享文件清单并管理删除。

### 环境变量

- `HOST`（默认 `0.0.0.0`）
- `PORT`（默认 `3000`）
- `CLEANUP_INTERVAL_MINUTES`（默认 `10`，后台清理过期文件的间隔）
- `ADMIN_PASSWORD`（必填，无默认值；页面/API 管理密码）
- `ADMIN_SESSION_TTL_HOURS`（默认 `12`，登录会话有效期）
- `ADMIN_SESSION_SECRET`（可选，会话签名密钥，建议生产环境设置）

> 未设置 `ADMIN_PASSWORD` 时服务会在启动阶段直接报错并退出。

## API

### 健康检查

```http
GET /health
```

### 访问控制

- 受保护：`GET /`、`GET /index.html`、`POST /upload`、`/admin/*`
- 公开：`GET /f/:token`、`GET /f/:token/info`、`GET /s/:token`

### 登录 / 退出（Web UI）

```http
POST /admin/login
Content-Type: application/json

{
  "password": "***"
}
```

成功后服务端设置 HttpOnly Cookie，会话用于后续管理请求。

```http
POST /admin/logout
```

清除会话 Cookie。

### 上传文件（需鉴权）

```http
POST /upload
Content-Type: multipart/form-data
```

表单字段：

- `file`：文件（必填）
- `expiresInHours`：过期小时数（可选，`1~168`）
- `expiresValue` + `expiresUnit`：过期数值与单位（可选，Web UI 使用该组合，`hour` 或 `day`）
- `maxDownloads`：最大下载次数（可选）

过期时间规则：
- 过期时间输入框有数值时，一定会计算 `expiresAt`
- 留空时 `expiresAt = null`，表示不过期

上传限制说明：
- 应用层不限制文件类型与上传速率；默认单文件上限 20GB（Fastify bodyLimit + multipart fileSize）。
- 同时保留“上传后仍至少保留 5GB 可用空间”策略。
- 若上游反向代理（如 Nginx）配置了 `client_max_body_size`，会由代理层先行拦截。
- 服务端会检测 multipart 截断（`file.truncated` / `limit`），若发生则返回 `413` 并删除临时文件。

返回示例：

```json
{
  "token": "...",
  "downloadUrl": "http://127.0.0.1:3000/f/...",
  "previewUrl": "http://127.0.0.1:3000/s/...",
  "expiresAt": null,
  "maxDownloads": 3
}
```

### 下载预览页（公开）

```http
GET /s/:token
```

返回 HTML 页面，显示文件名、文件大小、过期时间、下载统计（当前下载次数 / 最大下载次数）。

### 下载文件（公开）

```http
GET /f/:token
```

### 查询文件信息（公开）

```http
GET /f/:token/info
```

## 管理接口（需鉴权）

### 查询存储空间

```http
GET /admin/storage
```

返回示例：

```json
{
  "totalBytes": 1024209543168,
  "usedBytes": 420954316800,
  "availableBytes": 603255226368,
  "total": "953.86 GB",
  "used": "392.04 GB",
  "available": "561.82 GB"
}
```

### 查询当前服务版本

```http
GET /admin/version
```

返回示例：

```json
{
  "version": "v0.1.0+abc1234"
}
```

### 清理已过期记录

```http
POST /admin/cleanup-expired
```

返回示例：

```json
{
  "cleanedCount": 3
}
```

### 获取当前可用文件列表（仅未过期）

```http
GET /admin/files
```

返回示例：

```json
{
  "files": [
    {
      "token": "...",
      "fileName": "demo.zip",
      "size": 123456,
      "createdAt": "2026-03-02T03:40:00.000Z",
      "expiresAt": null,
      "downloadCount": 0,
      "maxDownloads": null,
      "downloadUrl": "http://127.0.0.1:3000/f/...",
      "previewUrl": "http://127.0.0.1:3000/s/..."
    }
  ]
}
```

字段说明：
- `createdAt`：文件创建时间
- `expiresAt`：过期时间，`null` 表示不过期
- `downloadCount`：当前已下载次数
- `maxDownloads`：最大下载次数，`null` 表示不限

### 删除指定文件

```http
DELETE /admin/files/:token
```

- 成功：`204 No Content`
- 文件不存在：`404`

### 批量删除文件

```http
DELETE /admin/files
Content-Type: application/json

{
  "tokens": ["tokenA", "tokenB"]
}
```

返回示例：

```json
{
  "removedCount": 2,
  "removedTokens": ["tokenA", "tokenB"],
  "notFoundTokens": []
}
```

## 构建运行

```bash
npm run build
npm start
```

## Docker 部署

```bash
docker compose up -d --build
```

服务端口：`3000`，数据目录映射在宿主机 `./data`。

## Nginx 反向代理示例

项目已提供示例配置文件：`nginx/file-relay-hub.conf.example`

关键点：

- `client_max_body_size 0`（不限制上传大小）
- 转发到 `127.0.0.1:3000`
- 保留真实客户端 IP 和转发协议头

可按需复制到 `/etc/nginx/conf.d/file-relay-hub.conf` 并重载：

```bash
sudo cp nginx/file-relay-hub.conf.example /etc/nginx/conf.d/file-relay-hub.conf
sudo nginx -t && sudo systemctl reload nginx
```

## 注意

- 当前版本使用单一管理密码，且必须通过 `ADMIN_PASSWORD` 环境变量显式配置强密码。
- 强烈建议生产环境额外开启：HTTPS、IP 访问限制、限流、审计日志。
