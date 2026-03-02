import Fastify, { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createWriteStream, createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { RelayStore } from './relay-store';

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GB
const DEFAULT_EXPIRES_HOURS = 24;
const MAX_EXPIRES_HOURS = 24 * 7;

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  const dataDir = path.join(process.cwd(), 'data');
  const store = new RelayStore(dataDir);
  await store.init();

  await app.register(multipart, {
    limits: {
      fileSize: MAX_FILE_SIZE,
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

    await pipeline(file.file, createWriteStream(filePath));

    const stat = await fs.stat(filePath);
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
    if (error instanceof Error && error.message.includes('File too large')) {
      return reply.code(413).send({ error: 'file too large (max 1GB)' });
    }

    app.log.error(error);
    return reply.code(500).send({ error: 'internal server error' });
  });

  return app;
}
