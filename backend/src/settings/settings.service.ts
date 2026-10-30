import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_SETTINGS, Settings } from './settings.defaults';

const TTL_MS = 30_000;

/** Typed, cached access to platform_settings with code defaults as fallback. */
export class SettingsService {
  private cache?: { at: number; value: Settings };
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<Settings> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.value;
    const rows = await this.prisma.platformSetting.findMany();
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const row of rows) if (row.key in DEFAULT_SETTINGS) merged[row.key] = row.value;
    this.cache = { at: Date.now(), value: merged as unknown as Settings };
    return this.cache.value;
  }

  invalidate() {
    this.cache = undefined;
  }
}
