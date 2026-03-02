import Fastify, { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createWriteStream, createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { RelayStore } from './relay-store';

const RESERVED_FREE_SPACE_BYTES = 5 * 1024 * 1024 * 1024; // keep 5GB free
const DEFAULT_EXPIRES_HOURS = 24;
const MAX_EXPIRES_HOURS = 24 * 7;

async function getAvailableBytes(targetDir: string): Promise<number> {
  const stats = await fs.statfs(targetDir);
  return stats.bavail * stats.bsize;
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  const dataDir = path.join(process.cwd(), 'data');
  const store = new RelayStore(dataDir);
  await store.init();

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

    const host = request.headers.host ?? 'localhost:3000';
    const protocol = (request.headers['x-forwarded-proto'] as string) || 'http';
    const downloadUrl = `${protocol}://${host}/f/${token}`;

    return reply.code(201).send({
      token,
      downloadUrl,
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

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOSPC') {
      return reply.code(507).send({ error: 'insufficient disk space on server' });
    }

    app.log.error(error);
    return reply.code(500).send({ error: 'internal server error' });
  });

  return app;
}
