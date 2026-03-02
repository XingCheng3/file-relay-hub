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
      for (const record of parsed.records ?? []) {
        this.records.set(record.token, {
          ...record,
          expiresAt: record.expiresAt ?? null
        });
      }
    } catch {
      await this.persist();
    }

    await this.cleanupExpired();
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
      // ignore
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

  private async persist(): Promise<void> {
    const data: RelayStoreData = {
      records: [...this.records.values()]
    };
    await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }
}
