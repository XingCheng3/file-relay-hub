import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface RelayFileRecord {
  token: string;
  originalName: string;
  storedName: string;
  filePath: string;
  size: number;
  mimeType: string;
  createdAt: string;
  expiresAt: string | null;
  downloadCount: number;
  maxDownloads: number | null;
}

interface RelayStoreData {
  records: RelayFileRecord[];
}

const DEFAULT_DATA: RelayStoreData = { records: [] };
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export class RelayStore {
  private readonly dataFilePath: string;
  private readonly uploadDir: string;
  private records = new Map<string, RelayFileRecord>();

  constructor(baseDir: string) {
    this.uploadDir = path.join(baseDir, 'uploads');
    this.dataFilePath = path.join(baseDir, 'relay-meta.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.uploadDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.dataFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as RelayStoreData;
      const records = Array.isArray(parsed.records) ? parsed.records : [];

      for (const record of records) {
        const normalized = this.normalizeRecord(record);
        if (!normalized) continue;
        this.records.set(normalized.token, normalized);
      }
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') {
        await this.persist();
      } else if (error instanceof SyntaxError) {
        const backupPath = `${this.dataFilePath}.corrupt-${Date.now()}`;
        await fs.rename(this.dataFilePath, backupPath).catch(() => undefined);
        this.records = new Map();
        await this.persist();
      } else {
        throw error;
      }
    }

    await this.cleanupExpired();
    await this.cleanupReachedDownloadLimit();
  }

  makeToken(): string {
    return crypto.randomBytes(24).toString('base64url');
  }

  makeStoredName(originalName: string): string {
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'file.bin';
    return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeName}`;
  }

  getUploadDir(): string {
    return this.uploadDir;
  }

  async create(record: RelayFileRecord): Promise<void> {
    this.records.set(record.token, record);
    await this.persist();
  }

  get(token: string): RelayFileRecord | undefined {
    return this.records.get(token);
  }

  list(): RelayFileRecord[] {
    return [...this.records.values()];
  }

  async increaseDownloadCount(token: string): Promise<void> {
    const item = this.records.get(token);
    if (!item) return;
    item.downloadCount += 1;
    this.records.set(token, item);
    await this.persist();
  }

  isExpired(record: RelayFileRecord): boolean {
    if (!record.expiresAt) return false;
    return new Date(record.expiresAt).getTime() <= Date.now();
  }

  isDownloadLimitReached(record: RelayFileRecord): boolean {
    if (record.maxDownloads === null) return false;
    return record.downloadCount >= record.maxDownloads;
  }

  async remove(token: string): Promise<boolean> {
    const record = this.records.get(token);
    if (!record) return false;

    this.records.delete(token);
    await this.persist();

    try {
      await fs.unlink(record.filePath);
    } catch {
      // ignore missing disk file
    }

    return true;
  }

  async cleanupExpired(): Promise<void> {
    const expiredTokens = [...this.records.values()]
      .filter((item) => this.isExpired(item))
      .map((item) => item.token);

    for (const token of expiredTokens) {
      await this.remove(token);
    }
  }

  async cleanupReachedDownloadLimit(): Promise<void> {
    const exceededTokens = [...this.records.values()]
      .filter((item) => this.isDownloadLimitReached(item))
      .map((item) => item.token);

    for (const token of exceededTokens) {
      await this.remove(token);
    }
  }

  private normalizeRecord(record: RelayFileRecord): RelayFileRecord | null {
    if (!record || typeof record !== 'object') return null;
    const token = typeof record.token === 'string' ? record.token.trim() : '';
    if (!TOKEN_PATTERN.test(token)) return null;

    const createdAtRaw = typeof record.createdAt === 'string' ? record.createdAt : '';
    const createdAt = Number.isNaN(new Date(createdAtRaw).getTime()) ? new Date().toISOString() : createdAtRaw;

    const expiresAtRaw = typeof record.expiresAt === 'string' ? record.expiresAt : null;
    const expiresAt = expiresAtRaw && !Number.isNaN(new Date(expiresAtRaw).getTime()) ? expiresAtRaw : null;

    const downloadCount = Number.isFinite(record.downloadCount) && record.downloadCount >= 0
      ? Math.floor(record.downloadCount)
      : 0;

    const maxDownloads = Number.isFinite(record.maxDownloads) && Number(record.maxDownloads) >= 1
      ? Math.floor(Number(record.maxDownloads))
      : null;

    return {
      token,
      originalName: typeof record.originalName === 'string' && record.originalName.trim() ? record.originalName : 'file.bin',
      storedName: typeof record.storedName === 'string' ? record.storedName : '',
      filePath: typeof record.filePath === 'string' && record.filePath.trim()
        ? record.filePath
        : path.join(this.uploadDir, typeof record.storedName === 'string' ? record.storedName : ''),
      size: Number.isFinite(record.size) && Number(record.size) >= 0 ? Number(record.size) : 0,
      mimeType: typeof record.mimeType === 'string' && record.mimeType.trim()
        ? record.mimeType
        : 'application/octet-stream',
      createdAt,
      expiresAt,
      downloadCount,
      maxDownloads
    };
  }

  private async persist(): Promise<void> {
    const data: RelayStoreData = {
      records: [...this.records.values()]
    };
    await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }
}
