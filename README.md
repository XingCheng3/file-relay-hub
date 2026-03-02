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
  - 获取“未过期可用文件清单”（含创建时间 `createdAt`）
  - 查询上传目录所在分区磁盘空间（总量/已使用/可用）
  - 单文件删除
  - 批量删除
- 页面访问密码保护：主页与管理操作需提供 `x-admin-password`
- 磁盘保护策略：上传后仍至少保留 5GB 可用空间（否则拒绝/回滚上传）
- 不限制文件类型、不做网速限流（当前版本）

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
- `ADMIN_PASSWORD`（默认 `17734`，页面/API 管理密码）

## API

### 健康检查

```http
GET /health
```

### 访问控制

- 主页 `GET /`、上传 `POST /upload`、管理接口 `GET/DELETE /admin/*` 需要密码。
- Web UI 会先输入密码并保存到 `sessionStorage`，后续请求自动携带 `x-admin-password`。
- 预览/下载分享链接（`/s/:token`、`/f/:token`）保持公开，不受该密码拦截。

### 上传文件

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
- 过期时间输入框有数值时，一定会计算 `expiresAt`（不会退化成“永不过期”）
- 留空时 `expiresAt = null`，表示不过期

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

> `expiresAt = null` 表示永久链接（不过期）。

### 下载预览页

```http
GET /s/:token
```

返回 HTML 页面，显示文件名、文件大小、过期时间（或“永不过期”）、下载次数，并提供下载按钮。

### 下载文件

```http
GET /f/:token
```

### 查询文件信息

```http
GET /f/:token/info
```

## 管理接口（需 `x-admin-password`）

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

### 获取当前可用文件列表（仅未过期，含创建时间）

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

- 当前版本使用单一管理密码（默认 `17734`），生产环境请务必通过环境变量设置强密码，并配合额外访问控制。
- 生产环境建议加：细粒度鉴权、限流、HTTPS、对象存储、审计日志。
