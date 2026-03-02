import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createWriteStream, createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { RelayStore, RelayFileRecord } from './relay-store';

const RESERVED_FREE_SPACE_BYTES = 5 * 1024 * 1024 * 1024; // keep 5GB free
const MAX_EXPIRES_HOURS = 24 * 7;
const DEFAULT_CLEANUP_INTERVAL_MINUTES = 10;
const APP_VERSION_FALLBACK = '0.0.0';

function getRequiredAdminPassword(): string {
  const value = process.env.ADMIN_PASSWORD?.trim() ?? '';
  if (!value) {
    throw new Error('ADMIN_PASSWORD is required. Refusing to start with empty admin password.');
  }
  return value;
}

const ADMIN_PASSWORD = getRequiredAdminPassword();
const ADMIN_SESSION_COOKIE_NAME = 'fileRelayHubAdminSession';
const ADMIN_SESSION_TTL_HOURS = Math.max(1, Number(process.env.ADMIN_SESSION_TTL_HOURS ?? 12));
const ADMIN_SESSION_MAX_AGE_SECONDS = Math.floor(ADMIN_SESSION_TTL_HOURS * 60 * 60);
const ADMIN_SESSION_SECRET =
  process.env.ADMIN_SESSION_SECRET?.trim() || `file-relay-hub:${ADMIN_PASSWORD}:admin-session`;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_BATCH_DELETE_TOKENS = 200;

async function getStorageStats(targetDir: string): Promise<{ total: number; used: number; available: number }> {
  const stats = await fs.statfs(targetDir);
  const total = stats.blocks * stats.bsize;
  const available = stats.bavail * stats.bsize;
  const used = Math.max(total - available, 0);
  return { total, used, available };
}

async function getAvailableBytes(targetDir: string): Promise<number> {
  const storage = await getStorageStats(targetDir);
  return storage.available;
}

async function resolveAppVersion(): Promise<string> {
  let version = APP_VERSION_FALLBACK;

  try {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const raw = await fs.readFile(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      version = parsed.version.trim();
    }
  } catch {
    // keep fallback version
  }

  const commitRaw = process.env.APP_COMMIT?.trim() || process.env.GIT_COMMIT?.trim() || '';
  const shortCommit = commitRaw ? commitRaw.slice(0, 7) : '';

  return shortCommit ? `v${version}+${shortCommit}` : `v${version}`;
}

function extractAdminPassword(headers: Record<string, unknown>): string {
  const raw = headers['x-admin-password'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getCookieValue(headers: Record<string, unknown>, key: string): string {
  const raw = headers.cookie;
  const cookieString = Array.isArray(raw) ? raw.join(';') : typeof raw === 'string' ? raw : '';
  if (!cookieString) return '';

  const pairs = cookieString.split(';');
  for (const pair of pairs) {
    const [name, ...rest] = pair.trim().split('=');
    if (name !== key) continue;
    return decodeURIComponent(rest.join('=') || '');
  }

  return '';
}

function makeAdminSessionToken(expiresAtMs: number): string {
  const payload = String(expiresAtMs);
  const signature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function verifyAdminSessionToken(token: string): boolean {
  const [expiresRaw, signature] = token.split('.');
  if (!expiresRaw || !signature) return false;
  if (!/^\d+$/.test(expiresRaw)) return false;
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;

  const expiresAtMs = Number(expiresRaw);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;

  const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(expiresRaw).digest('hex');
  return safeCompare(expected, signature);
}

function buildSetCookieValue(value: string, secure: boolean): string {
  const parts = [
    `${ADMIN_SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}`
  ];

  if (secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function isHttpsRequest(request: FastifyRequest): boolean {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  if (typeof proto === 'string') {
    return proto.split(',')[0]?.trim().toLowerCase() === 'https';
  }
  return request.protocol === 'https';
}

function setAdminSessionCookie(reply: FastifyReply, request: FastifyRequest): void {
  const expiresAt = Date.now() + ADMIN_SESSION_MAX_AGE_SECONDS * 1000;
  const token = makeAdminSessionToken(expiresAt);
  reply.header('Set-Cookie', buildSetCookieValue(token, isHttpsRequest(request)));
}

function clearAdminSessionCookie(reply: FastifyReply, request: FastifyRequest): void {
  const parts = [
    `${ADMIN_SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];

  if (isHttpsRequest(request)) {
    parts.push('Secure');
  }

  reply.header('Set-Cookie', parts.join('; '));
}

function isAuthorizedAdminRequest(request: { headers: Record<string, unknown> }): boolean {
  const headerPassword = extractAdminPassword(request.headers);
  if (headerPassword && safeCompare(headerPassword, ADMIN_PASSWORD)) {
    return true;
  }

  const sessionToken = getCookieValue(request.headers, ADMIN_SESSION_COOKIE_NAME);
  return sessionToken ? verifyAdminSessionToken(sessionToken) : false;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '永不过期';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function getBaseUrl(request: { headers: Record<string, unknown> }): string {
  const host = (request.headers.host as string | undefined) ?? 'localhost:3000';
  const protocol = (request.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  return `${protocol}://${host}`;
}

function normalizeToken(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function isValidToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

function safeDownloadFilename(name: string): string {
  const cleaned = name.replace(/[\r\n"\\]/g, '_').trim();
  return cleaned || 'download.bin';
}

function toContentDisposition(filename: string): string {
  const fallback = safeDownloadFilename(filename);
  const encoded = encodeURIComponent(filename)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%(7C|60|5E)/g, (m) => m.toLowerCase());

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function renderPageShell(content: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>File Relay Hub</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        margin: 0;
        background: radial-gradient(circle at 20% 20%, #152448 0, #0b1020 45%, #050810 100%);
        color: #e8ecf3;
      }
      .wrap { max-width: 760px; margin: 42px auto; padding: 0 16px; }
      .card {
        background: #141b31;
        border: 1px solid #2a365e;
        border-radius: 16px;
        padding: 22px;
        box-shadow: 0 12px 30px rgba(0,0,0,.28);
      }
      h1 { margin: 0 0 8px; font-size: 24px; }
      .muted { color: #9db0d8; margin-top: 0; }
      .grid {
        margin-top: 18px;
        display: grid;
        grid-template-columns: 140px 1fr;
        row-gap: 10px;
        column-gap: 12px;
      }
      .label { color: #9db0d8; font-size: 14px; }
      .value { word-break: break-all; }
      .button {
        margin-top: 22px;
        display: inline-block;
        text-decoration: none;
        border: none;
        border-radius: 10px;
        background: #4f7cff;
        color: #fff;
        font-weight: 600;
        padding: 11px 18px;
      }
      .button.secondary { background: #2f3f6e; }
      .button-row { display: flex; gap: 10px; flex-wrap: wrap; }
      .badge {
        display: inline-block;
        font-size: 12px;
        padding: 4px 9px;
        border-radius: 999px;
        background: rgba(79, 124, 255, .2);
        border: 1px solid rgba(138, 180, 255, .4);
        color: #b9cbf5;
      }
      .status-title { margin-bottom: 4px; }
    </style>
  </head>
  <body>
    <div class="wrap">${content}</div>
  </body>
</html>`;
}

function renderPreviewPage(record: RelayFileRecord, baseUrl: string): string {
  const token = escapeHtml(record.token);
  const originalName = escapeHtml(record.originalName);
  const downloadHref = `${baseUrl}/f/${record.token}`;
  const escapedDownloadHref = escapeHtml(downloadHref);
  const maxDownloads = record.maxDownloads === null ? '不限' : String(record.maxDownloads);

  return renderPageShell(`
    <div class="card">
      <span class="badge">文件分享页</span>
      <h1>📦 ${originalName}</h1>
      <p class="muted">该文件由 File Relay Hub 暂存托管，点击按钮可直接下载。</p>
      <div class="grid">
        <div class="label">Token</div><div class="value">${token}</div>
        <div class="label">文件大小</div><div class="value">${formatBytes(record.size)} (${record.size} bytes)</div>
        <div class="label">过期时间</div><div class="value">${escapeHtml(formatDateTime(record.expiresAt))}</div>
        <div class="label">下载计数</div><div class="value">当前 ${record.downloadCount} / 最大 ${maxDownloads}</div>
      </div>

      <div style="margin-top:14px">
        <div class="label" style="margin-bottom:6px">下载链接（可复制分享）</div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
          <input id="download-link" value="${escapedDownloadHref}" readonly style="flex:1; min-width:260px; border-radius:8px; border:1px solid #3a4b7e; background:#0f1630; color:#e8ecf3; padding:10px" />
          <button class="button" id="copy-btn" type="button" style="margin-top:0">复制链接</button>
        </div>
        <div id="copy-tip" class="muted" style="margin-top:6px"></div>
      </div>

      <div class="button-row">
        <a class="button" href="${escapedDownloadHref}">下载文件</a>
      </div>
    </div>
    <script>
      (function () {
        var btn = document.getElementById('copy-btn');
        var input = document.getElementById('download-link');
        var tip = document.getElementById('copy-tip');
        if (!btn || !input) return;
        btn.addEventListener('click', async function () {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(input.value);
            } else {
              input.select();
              document.execCommand('copy');
            }
            if (tip) tip.textContent = '已复制到剪贴板';
          } catch {
            if (tip) tip.textContent = '复制失败，请手动复制';
          }
        });
      })();
    </script>
  `);
}

function renderStatusPage(title: string, message: string): string {
  return renderPageShell(`
    <div class="card">
      <h1 class="status-title">${escapeHtml(title)}</h1>
      <p class="muted">${escapeHtml(message)}</p>
    </div>
  `);
}

function renderLoginPage(message = ''): string {
  const safeMessage = escapeHtml(message);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>File Relay Hub - 访问验证</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        margin: 0;
        background: radial-gradient(circle at 20% 20%, #152448 0, #0b1020 45%, #050810 100%);
        color: #e8ecf3;
      }
      .wrap { max-width: 480px; margin: 72px auto; padding: 0 16px; }
      .card {
        background: #141b31;
        border: 1px solid #2a365e;
        border-radius: 16px;
        padding: 22px;
        box-shadow: 0 12px 30px rgba(0,0,0,.28);
      }
      h1 { margin: 0 0 10px; font-size: 22px; }
      .muted { color: #9db0d8; margin: 0 0 14px; }
      label { display: block; margin: 10px 0 6px; color: #c9d3ea; font-size: 14px; }
      input {
        width: 100%;
        box-sizing: border-box;
        padding: 10px;
        border-radius: 10px;
        border: 1px solid #3a4b7e;
        background: #0f1630;
        color: #e8ecf3;
      }
      button {
        margin-top: 12px;
        width: 100%;
        border: none;
        border-radius: 10px;
        background: #4f7cff;
        color: #fff;
        font-weight: 600;
        padding: 11px 16px;
        cursor: pointer;
      }
      .error { color: #ff8d8d; min-height: 20px; margin-top: 10px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>🔐 请输入访问密码</h1>
        <p class="muted">通过验证后才能进入 File Relay Hub 管理页面。</p>
        <form id="login-form">
          <label for="password">访问密码</label>
          <input id="password" type="password" autocomplete="current-password" required />
          <button type="submit">进入</button>
          <div id="error" class="error">${safeMessage}</div>
        </form>
      </div>
    </div>

    <script>
      (function () {
        var form = document.getElementById('login-form');
        var input = document.getElementById('password');
        var errorEl = document.getElementById('error');

        if (!form || !input) return;

        form.addEventListener('submit', async function (e) {
          e.preventDefault();
          var password = input.value.trim();
          if (!password) {
            if (errorEl) errorEl.textContent = '请输入密码';
            return;
          }

          try {
            var res = await fetch('/admin/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: password })
            });

            var payload = await res.json().catch(function () { return {}; });
            if (!res.ok) {
              throw new Error(payload.error || '密码错误，请重试');
            }

            window.location.href = '/';
          } catch (err) {
            if (errorEl) errorEl.textContent = (err && err.message) || '验证失败';
            input.focus();
            input.select();
          }
        });
      })();
    </script>
  </body>
</html>`;
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const appVersion = await resolveAppVersion();

  const dataDir = path.join(process.cwd(), 'data');
  const store = new RelayStore(dataDir);
  await store.init();

  const cleanupIntervalMinutes = Number(process.env.CLEANUP_INTERVAL_MINUTES ?? DEFAULT_CLEANUP_INTERVAL_MINUTES);
  const cleanupEveryMs = Number.isFinite(cleanupIntervalMinutes) && cleanupIntervalMinutes > 0
    ? cleanupIntervalMinutes * 60 * 1000
    : DEFAULT_CLEANUP_INTERVAL_MINUTES * 60 * 1000;

  const cleanupTimer = setInterval(() => {
    void store.cleanupExpired().catch((error) => app.log.error({ error }, 'cleanup job failed'));
  }, cleanupEveryMs);

  app.addHook('onClose', async () => {
    clearInterval(cleanupTimer);
  });

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  });

  await app.register(multipart, {
    limits: {
      files: 1
    }
  });

  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/'
  });

  const requireAdminAccess = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAuthorizedAdminRequest(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    if (extractAdminPassword(request.headers)) {
      setAdminSessionCookie(reply, request);
    }
  };

  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'file-relay-hub'
    };
  });

  app.post('/admin/login', async (request, reply) => {
    const body = (request.body ?? {}) as { password?: unknown };
    const inputPassword = typeof body.password === 'string' ? body.password.trim() : '';

    if (!inputPassword || !safeCompare(inputPassword, ADMIN_PASSWORD)) {
      clearAdminSessionCookie(reply, request);
      return reply.code(401).send({ error: 'invalid password' });
    }

    setAdminSessionCookie(reply, request);
    return { ok: true };
  });

  app.post('/admin/logout', async (request, reply) => {
    clearAdminSessionCookie(reply, request);
    return reply.code(204).send();
  });

  app.get('/admin/version', { preHandler: requireAdminAccess }, async () => {
    return { version: appVersion };
  });

  const serveAdminIndex = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAuthorizedAdminRequest(request)) {
      return reply
        .code(401)
        .type('text/html; charset=utf-8')
        .send(renderLoginPage());
    }

    setAdminSessionCookie(reply, request);
    return reply.sendFile('index.html');
  };

  app.get('/', serveAdminIndex);
  app.get('/index.html', serveAdminIndex);

  app.post('/upload', { preHandler: requireAdminAccess }, async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'missing file in multipart field "file"' });
    }

    if (!file.filename || file.filename.trim().length === 0) {
      return reply.code(400).send({ error: 'invalid file name' });
    }

    if (file.filename.length > 255) {
      return reply.code(400).send({ error: 'file name too long (max 255)' });
    }

    const fields = file.fields as Record<string, { value: string }>;

    const expiresInHoursRaw = fields.expiresInHours?.value?.trim() ?? '';
    const expiresValueRaw = fields.expiresValue?.value?.trim() ?? '';
    const expiresUnitRaw = fields.expiresUnit?.value?.trim() ?? 'hour';

    let expiresInHours: number | null = null;
    if (expiresInHoursRaw !== '') {
      const parsedExpires = Number(expiresInHoursRaw);
      if (!Number.isFinite(parsedExpires)) {
        return reply.code(400).send({ error: 'invalid expiresInHours' });
      }
      expiresInHours = Math.min(Math.max(1, Math.floor(parsedExpires)), MAX_EXPIRES_HOURS);
    } else if (expiresValueRaw !== '') {
      const parsedValue = Number(expiresValueRaw);
      if (!Number.isFinite(parsedValue) || parsedValue < 1) {
        return reply.code(400).send({ error: 'invalid expiresValue' });
      }

      const unit = expiresUnitRaw === 'day' ? 'day' : 'hour';
      const normalizedValue = Math.floor(parsedValue);
      if (unit === 'day') {
        const cappedDays = Math.min(normalizedValue, 7);
        expiresInHours = cappedDays * 24;
      } else {
        expiresInHours = Math.min(normalizedValue, MAX_EXPIRES_HOURS);
      }
    }

    const maxDownloadsRaw = fields.maxDownloads?.value?.trim() ?? '';
    let maxDownloads: number | null = null;
    if (maxDownloadsRaw !== '') {
      const parsedMaxDownloads = Number(maxDownloadsRaw);
      if (!Number.isFinite(parsedMaxDownloads) || parsedMaxDownloads < 1) {
        return reply.code(400).send({ error: 'invalid maxDownloads' });
      }
      maxDownloads = Math.max(1, Math.floor(parsedMaxDownloads));
    }

    const token = store.makeToken();
    const storedName = store.makeStoredName(file.filename);
    const filePath = path.join(store.getUploadDir(), storedName);

    const freeBeforeUpload = await getAvailableBytes(store.getUploadDir());
    if (freeBeforeUpload <= RESERVED_FREE_SPACE_BYTES) {
      return reply.code(507).send({
        error: 'insufficient disk space: server keeps at least 5GB free'
      });
    }

    await pipeline(file.file, createWriteStream(filePath));

    const stat = await fs.stat(filePath);
    const freeAfterUpload = await getAvailableBytes(store.getUploadDir());
    if (freeAfterUpload < RESERVED_FREE_SPACE_BYTES) {
      await fs.unlink(filePath).catch(() => undefined);
      return reply.code(507).send({
        error: 'insufficient disk space after upload: file removed to keep 5GB free'
      });
    }

    const now = new Date();
    const expiresAt = expiresInHours === null
      ? null
      : new Date(now.getTime() + expiresInHours * 60 * 60 * 1000).toISOString();

    await store.create({
      token,
      originalName: file.filename,
      storedName,
      filePath,
      size: stat.size,
      mimeType: file.mimetype || 'application/octet-stream',
      createdAt: now.toISOString(),
      expiresAt,
      downloadCount: 0,
      maxDownloads
    });

    const baseUrl = getBaseUrl(request);

    return reply.code(201).send({
      token,
      downloadUrl: `${baseUrl}/f/${token}`,
      previewUrl: `${baseUrl}/s/${token}`,
      expiresAt,
      maxDownloads
    });
  });

  app.get('/f/:token/info', async (request, reply) => {
    const token = normalizeToken((request.params as { token?: string }).token);
    if (!isValidToken(token)) {
      return reply.code(400).send({ error: 'invalid token' });
    }

    const record = store.get(token);

    if (!record) return reply.code(404).send({ error: 'file not found' });
    if (store.isExpired(record)) {
      await store.remove(token);
      return reply.code(410).send({ error: 'link expired' });
    }

    return {
      token: record.token,
      originalName: record.originalName,
      size: record.size,
      mimeType: record.mimeType,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      downloadCount: record.downloadCount,
      maxDownloads: record.maxDownloads
    };
  });

  app.get('/s/:token', async (request, reply) => {
    const token = normalizeToken((request.params as { token?: string }).token);
    if (!isValidToken(token)) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(renderStatusPage('链接无效', '分享链接格式不正确。'));
    }

    const record = store.get(token);

    if (!record) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(renderStatusPage('文件不存在', '未找到对应文件，可能已被删除。'));
    }

    if (store.isExpired(record)) {
      await store.remove(token);
      return reply
        .code(410)
        .type('text/html; charset=utf-8')
        .send(renderStatusPage('链接已过期', '该文件已超过有效期，无法继续下载。'));
    }

    if (store.isDownloadLimitReached(record)) {
      await store.remove(token);
      return reply
        .code(410)
        .type('text/html; charset=utf-8')
        .send(renderStatusPage('下载次数已达上限', '该文件已达到最大下载次数，链接失效。'));
    }

    try {
      await fs.access(record.filePath);
    } catch {
      await store.remove(token);
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(renderStatusPage('文件缺失', '文件元数据存在，但磁盘文件已丢失。'));
    }

    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(renderPreviewPage(record, getBaseUrl(request)));
  });

  app.get('/f/:token', async (request, reply) => {
    const token = normalizeToken((request.params as { token?: string }).token);
    if (!isValidToken(token)) {
      return reply.code(400).send({ error: 'invalid token' });
    }

    const record = store.get(token);

    if (!record) return reply.code(404).send({ error: 'file not found' });

    if (store.isExpired(record)) {
      await store.remove(token);
      return reply.code(410).send({ error: 'link expired' });
    }

    if (store.isDownloadLimitReached(record)) {
      await store.remove(token);
      return reply.code(410).send({ error: 'download limit reached' });
    }

    try {
      await fs.access(record.filePath);
    } catch {
      await store.remove(token);
      return reply.code(404).send({ error: 'file missing on disk' });
    }

    await store.increaseDownloadCount(token);

    const contentType = record.mimeType || 'application/octet-stream';
    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', toContentDisposition(record.originalName));
    return reply.send(createReadStream(record.filePath));
  });

  app.get('/admin/storage', { preHandler: requireAdminAccess }, async (_request, reply) => {
    try {
      const storage = await getStorageStats(store.getUploadDir());

      return {
        totalBytes: storage.total,
        usedBytes: storage.used,
        availableBytes: storage.available,
        total: formatBytes(storage.total),
        used: formatBytes(storage.used),
        available: formatBytes(storage.available)
      };
    } catch {
      return reply.code(500).send({ error: 'failed to query storage stats' });
    }
  });

  app.post('/admin/cleanup-expired', { preHandler: requireAdminAccess }, async () => {
    const cleanedCount = await store.cleanupExpired();
    return { cleanedCount };
  });

  app.get('/admin/files', { preHandler: requireAdminAccess }, async (request) => {
    const records = store.list();
    const baseUrl = getBaseUrl(request);
    const availableFiles: Array<{
      token: string;
      fileName: string;
      size: number;
      createdAt: string;
      expiresAt: string | null;
      downloadCount: number;
      maxDownloads: number | null;
      downloadUrl: string;
      previewUrl: string;
    }> = [];

    for (const record of records) {
      if (store.isExpired(record) || store.isDownloadLimitReached(record)) {
        await store.remove(record.token);
        continue;
      }

      try {
        await fs.access(record.filePath);
      } catch {
        await store.remove(record.token);
        continue;
      }

      availableFiles.push({
        token: record.token,
        fileName: record.originalName,
        size: record.size,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        downloadCount: record.downloadCount,
        maxDownloads: record.maxDownloads,
        downloadUrl: `${baseUrl}/f/${record.token}`,
        previewUrl: `${baseUrl}/s/${record.token}`
      });
    }

    return { files: availableFiles };
  });

  app.delete('/admin/files/:token', { preHandler: requireAdminAccess }, async (request, reply) => {
    const token = normalizeToken((request.params as { token?: string }).token);
    if (!isValidToken(token)) {
      return reply.code(400).send({ error: 'invalid token' });
    }

    const removed = await store.remove(token);

    if (!removed) {
      return reply.code(404).send({ error: 'file not found' });
    }

    return reply.code(204).send();
  });

  app.delete('/admin/files', { preHandler: requireAdminAccess }, async (request, reply) => {
    const body = (request.body ?? {}) as { tokens?: unknown };
    if (!Array.isArray(body.tokens)) {
      return reply.code(400).send({ error: 'tokens must be an array' });
    }

    if (body.tokens.length > MAX_BATCH_DELETE_TOKENS) {
      return reply.code(400).send({ error: `too many tokens, max ${MAX_BATCH_DELETE_TOKENS}` });
    }

    const normalizedTokens = body.tokens
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    const invalidTokens = normalizedTokens.filter((token) => !isValidToken(token));
    if (invalidTokens.length > 0) {
      return reply.code(400).send({ error: 'tokens contain invalid values', invalidTokens });
    }

    const tokens = [...new Set(normalizedTokens)];
    if (tokens.length === 0) {
      return reply.code(400).send({ error: 'tokens array is empty' });
    }

    const removedTokens: string[] = [];
    const notFoundTokens: string[] = [];

    for (const token of tokens) {
      const removed = await store.remove(token);
      if (removed) {
        removedTokens.push(token);
      } else {
        notFoundTokens.push(token);
      }
    }

    return {
      removedCount: removedTokens.length,
      removedTokens,
      notFoundTokens
    };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOSPC') {
      return reply.code(507).send({ error: 'insufficient disk space on server' });
    }

    app.log.error(error);
    return reply.code(500).send({ error: 'internal server error' });
  });

  return app;
}
