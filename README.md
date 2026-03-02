# file-relay-hub

临时文件中转服务（Node.js + TypeScript + Fastify）。

## 功能（MVP）

- 上传文件（multipart）
- 生成可分享下载链接
- 链接过期时间（默认 24h，最大 7 天）
- 可选最大下载次数（到达后链接失效）
- 本地磁盘存储（`data/uploads`）
- 磁盘保护策略：上传后仍至少保留 5GB 可用空间（否则拒绝/回滚上传）
- 不限制文件类型、不做网速限流（当前版本）

## 快速开始

```bash
npm install
npm run dev
```

默认监听：`http://0.0.0.0:3000`

浏览器访问 `http://<host>:3000/` 可使用 Web UI 上传文件并生成分享链接。

### 环境变量

- `HOST`（默认 `0.0.0.0`）
- `PORT`（默认 `3000`）
- `CLEANUP_INTERVAL_MINUTES`（默认 `10`，后台清理过期文件的间隔）

## API

### 健康检查

```http
GET /health
```

### 上传文件

```http
POST /upload
Content-Type: multipart/form-data
```

表单字段：

- `file`：文件（必填）
- `expiresInHours`：过期小时数（可选，默认 24，最大 168）
- `maxDownloads`：最大下载次数（可选）

返回示例：

```json
{
  "token": "...",
  "downloadUrl": "http://127.0.0.1:3000/f/...",
  "expiresAt": "2026-03-03T10:00:00.000Z",
  "maxDownloads": 3
}
```

### 下载文件

```http
GET /f/:token
```

### 查询文件信息

```http
GET /f/:token/info
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

## 注意

- 当前为 MVP，本地磁盘存储，未接入用户认证。
- 生产环境建议加：鉴权、限流、Nginx、HTTPS、对象存储、审计日志。
