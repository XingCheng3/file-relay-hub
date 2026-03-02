import Fastify, { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createWriteStream, createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { RelayStore, RelayFileRecord } from './relay-store';

const RESERVED_FREE_SPACE_BYTES = 5 * 1024 * 1024 * 1024; // keep 5GB free
const DEFAULT_EXPIRES_HOURS = 24;
const MAX_EXPIRES_HOURS = 24 * 7;
const DEFAULT_CLEANUP_INTERVAL_MINUTES = 10;

async function getAvailableBytes(targetDir: string): Promise<number> {
  const stats = await fs.statfs(targetDir);
  return stats.bavail * stats.bsize;
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

function formatDateTime(iso: string): string {
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

function renderPageShell(content: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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

  return renderPageShell(`
    <div class="card">
      <span class="badge">文件分享页</span>
      <h1>📦 ${originalName}</h1>
      <p class="muted">该文件由 File Relay Hub 暂存托管，点击按钮可直接下载。</p>
      <div class="grid">
        <div class="label">Token</div><div class="value">${token}</div>
        <div class="label">文件大小</div><div class="value">${formatBytes(record.size)} (${record.size} bytes)</div>
        <div class="label">过期时间</div><div class="value">${escapeHtml(formatDateTime(record.expiresAt))}</div>
        <div class="label">下载次数</div><div class="value">${record.downloadCount}${record.maxDownloads ? ` / ${record.maxDownloads}` : ''}</div>
      </div>
      <div class="button-row">
        <a class="button" href="${escapeHtml(downloadHref)}">下载文件</a>
        <a class="button secondary" href="/">返回上传页</a>
      </div>
    </div>
  `);
}

function renderStatusPage(title: string, message: string): string {
  return renderPageShell(`
    <div class="card">
      <h1 class="status-title">${escapeHtml(title)}</h1>
      <p class="muted">${escapeHtml(message)}</p>
      <a class="button secondary" href="/">返回上传页</a>
    </div>
  `);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

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

  await app.register(multipart, {
    limits: {
      files: 1
    }
  });

  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/'
  });

  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'file-relay-hub'
    };
  });

  app.get('/', async (_request, reply) => {
    return reply.sendFile('index.html');
  });

  app.post('/upload', async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'missing file in multipart field "file"' });
    }

    const fields = file.fields as Record<string, { value: string }>;
    const expiresInput = Number(fields.expiresInHours?.value ?? DEFAULT_EXPIRES_HOURS);
    const maxDownloadsInput = fields.maxDownloads?.value ? Number(fields.maxDownloads.value) : null;

    const expiresInHours = Number.isFinite(expiresInput)
      ? Math.min(Math.max(1, expiresInput), MAX_EXPIRES_HOURS)
      : DEFAULT_EXPIRES_HOURS;

    const maxDownloads = maxDownloadsInput && Number.isFinite(maxDownloadsInput)
      ? Math.max(1, Math.floor(maxDownloadsInput))
      : null;

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
    const expiresAt = new Date(now.getTime() + expiresInHours * 60 * 60 * 1000);

    await store.create({
      token,
      originalName: file.filename,
      storedName,
      filePath,
      size: stat.size,
      mimeType: file.mimetype || 'application/octet-stream',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      downloadCount: 0,
      maxDownloads
    });

    const baseUrl = getBaseUrl(request);

    return reply.code(201).send({
      token,
      downloadUrl: `${baseUrl}/f/${token}`,
      previewUrl: `${baseUrl}/s/${token}`,
      expiresAt: expiresAt.toISOString(),
      maxDownloads
    });
  });

  app.get('/f/:token/info', async (request, reply) => {
    const token = (request.params as { token: string }).token;
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
    const token = (request.params as { token: string }).token;
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
    const token = (request.params as { token: string }).token;
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
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(record.originalName)}"`);
    return reply.send(createReadStream(record.filePath));
  });

  app.get('/admin/files', async () => {
    const records = store.list();
    const availableFiles: Array<{
      token: string;
      fileName: string;
      size: number;
      expiresAt: string;
      downloadCount: number;
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
        expiresAt: record.expiresAt,
        downloadCount: record.downloadCount
      });
    }

    return { files: availableFiles };
  });

  app.delete('/admin/files/:token', async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const removed = await store.remove(token);

    if (!removed) {
      return reply.code(404).send({ error: 'file not found' });
    }

    return reply.code(204).send();
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
