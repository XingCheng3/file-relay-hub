# file-relay-hub

[![GitHub stars](https://img.shields.io/github/stars/XingCheng3/file-relay-hub?style=social)](https://github.com/XingCheng3/file-relay-hub/stargazers)
[![CI](https://github.com/XingCheng3/file-relay-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/XingCheng3/file-relay-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

一个轻量的**文件中转服务**：上传文件后生成可分享链接，支持后台管理、可选过期时间、可选下载次数限制，以及磁盘安全保护。

> English README: [README.en.md](./README.en.md)

---

## ✨ 功能特性

- Web UI / API 上传文件
- 生成可分享链接：
  - 直链下载：`/f/:token`
  - 预览分享页：`/s/:token`
- 可选过期时间：
  - 支持按「小时 / 天」设置
  - 留空表示不过期
- 可选最大下载次数限制
- 管理后台（密码保护）：
  - 查看可用文件清单
  - 单删 / 多选批量删除
  - 手动清理过期记录
  - 查看磁盘空间（总量 / 已用 / 可用）
  - 显示当前服务版本
- 磁盘保护策略：上传后仍至少保留 **5GB** 可用空间
- 分享链接（`/f/*`、`/s/*`）可公开访问，不要求后台登录

---

## 🧱 技术栈

- Node.js + TypeScript
- Fastify
- `@fastify/multipart`（上传）
- `@fastify/static`（静态页面）
- 本地磁盘存储（`data/uploads`）+ JSON 元数据（`data/relay-meta.json`）

---

## 🚀 快速开始

```bash
git clone https://github.com/XingCheng3/file-relay-hub.git
cd file-relay-hub
npm install
```

### 1) 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少填写 ADMIN_PASSWORD
```

### 2) 启动服务

```bash
npm run dev
```

访问：`http://127.0.0.1:3000/`

---

## ⚙️ 环境变量

| 名称 | 必填 | 默认值 | 说明 |
|---|---|---:|---|
| `HOST` | 否 | `0.0.0.0` | 监听地址 |
| `PORT` | 否 | `3000` | 服务端口 |
| `ADMIN_PASSWORD` | **是** | - | 后台管理密码（启动必填） |
| `ADMIN_SESSION_TTL_HOURS` | 否 | `12` | 后台登录会话有效期（小时） |
| `ADMIN_SESSION_SECRET` | 否 | 派生值 | 会话签名密钥（生产建议显式设置） |
| `CLEANUP_INTERVAL_MINUTES` | 否 | `10` | 过期记录自动清理间隔 |

> 未设置 `ADMIN_PASSWORD` 时，服务会在启动阶段直接报错退出。

---

## 📦 上传限制与吞吐说明

- 应用层不限制文件类型
- 应用层不做限速
- 应用层默认单文件上限 **20GB**
- 同时受“上传后保留至少 5GB 可用空间”策略约束
- 若使用 Nginx/Caddy 等反向代理，代理层限制（如 `client_max_body_size`）会优先生效

---

## 🔌 API 概览

### 公开接口
- `GET /health`
- `GET /f/:token`（下载）
- `GET /f/:token/info`
- `GET /s/:token`（预览页）

### 受保护接口（需后台认证）
- `GET /` / `GET /index.html`
- `POST /upload`
- `POST /admin/login`
- `POST /admin/logout`
- `GET /admin/files`
- `DELETE /admin/files/:token`
- `DELETE /admin/files`（批量）
- `POST /admin/cleanup-expired`
- `GET /admin/storage`
- `GET /admin/version`

完整示例见：**[docs/API.md](./docs/API.md)**

---

## 📁 存储路径

- 文件实体：`data/uploads/`
- 元数据：`data/relay-meta.json`

路径相对于项目根目录。

---

## 🐳 Docker 部署

```bash
docker compose up -d --build
```

默认映射：
- 端口：`3000:3000`
- 数据卷：`./data:/app/data`

Nginx 示例配置：`nginx/file-relay-hub.conf.example`

---

## 🔐 安全建议

- 不要把真实密码 / Token 提交到仓库
- 生产环境请设置强密码与 `ADMIN_SESSION_SECRET`
- 生产环境建议启用 HTTPS
- 建议反向代理层加日志、限流和基础防护
- 凭据疑似泄露时立即轮换

---

## 🧪 开发脚本

```bash
npm run dev
npm run build
npm start
```

---

## 🗺️ 路线图

- [ ] 对象存储后端（S3/MinIO）
- [ ] 可插拔鉴权方案
- [ ] 更细粒度的限流与滥用防护
- [ ] 可观测性与监控增强

---

## 🤝 贡献

欢迎提 Issue / PR。

贡献前请阅读：**[CONTRIBUTING.md](./CONTRIBUTING.md)**

---

## 📄 许可证

MIT
