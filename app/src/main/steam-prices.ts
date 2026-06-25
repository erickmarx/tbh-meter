// steam-prices.ts — fetch item prices from Steam Community Market, cached locally.
// Materials (itemKey < 300k): 1h TTL. Equipment: 6h TTL.
// Null prices for equipment are NEVER cached — the market can open/close.
// Cache at ~/tbh-meter/prices.json (same dir as raw/logs).

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriceEntry {
  itemKey: number;
  name: string;
  price: number | null;
  volume: number;
  source: "steam" | "cache";
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const MATERIAL_TTL_MS = 60 * 60 * 1000; // 1 hour
const EQUIPMENT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function cacheDir(): string {
  const d = join(process.env.HOME ?? process.env.USERPROFILE ?? "~", "tbh-meter");
  mkdirSync(d, { recursive: true });
  return d;
}

function cachePath(): string {
  return join(cacheDir(), "prices.json");
}

let _cache: Map<number, PriceEntry> | null = null;

function loadCache(): Map<number, PriceEntry> {
  if (_cache) return _cache;
  _cache = new Map();
  try {
    if (existsSync(cachePath())) {
      const raw = JSON.parse(readFileSync(cachePath(), "utf-8")) as Record<string, PriceEntry>;
      for (const [k, v] of Object.entries(raw)) {
        _cache.set(Number(k), v);
      }
    }
  } catch {
    // corrupt cache → start fresh
  }
  return _cache;
}

function persistCache(): void {
  const obj: Record<string, PriceEntry> = {};
  for (const [k, v] of loadCache()) {
    obj[String(k)] = v;
  }
  writeFileSync(cachePath(), JSON.stringify(obj, null, 2), "utf-8");
}

export function clearPriceCache(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Steam API
// ---------------------------------------------------------------------------

function parseSteamPrice(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseSteamVolume(s: string | undefined): number {
  if (!s) return 0;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchOneFromSteam(itemKey: number, name: string): Promise<PriceEntry> {
  const encoded = encodeURIComponent(name);
  const url = `https://steamcommunity.com/market/priceoverview/?appid=3678970&currency=1&market_hash_name=${encoded}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(`Steam fetch failed for "${name}"`);
  }

  if (!res.ok) throw new Error(`Steam returned ${res.status} for "${name}"`);

  const data = (await res.json()) as {
    success: boolean;
    lowest_price?: string;
    median_price?: string;
    volume?: string;
  };

  if (!data.success) throw new Error(`Steam error for "${name}"`);

  return {
    itemKey,
    name,
    price: parseSteamPrice(data.median_price ?? data.lowest_price),
    volume: parseSteamVolume(data.volume),
    source: "steam",
    fetchedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMaterial(itemKey: number): boolean {
  return itemKey < 300_000;
}

function isFresh(cached: PriceEntry, itemKey: number): boolean {
  const ttl = isMaterial(itemKey) ? MATERIAL_TTL_MS : EQUIPMENT_TTL_MS;
  // Equipment with null price: NEVER serve from cache (market can open/close)
  if (!isMaterial(itemKey) && cached.price === null) return false;
  return Date.now() - cached.fetchedAt < ttl;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get prices from cache only — returns immediately, no network. */
export function getCachedPrices(
  items: { itemKey: number; name: string }[],
): Map<number, PriceEntry> {
  const out = new Map<number, PriceEntry>();
  const cache = loadCache();

  for (const { itemKey, name } of items) {
    const cached = cache.get(itemKey);
    if (cached && isFresh(cached, itemKey)) {
      out.set(itemKey, { ...cached, source: "cache" as const });
    } else {
      // Not in cache or stale → placeholder
      out.set(itemKey, {
        itemKey,
        name,
        price: cached?.price ?? null,
        volume: cached?.volume ?? 0,
        source: "cache" as const,
        fetchedAt: cached?.fetchedAt ?? 0,
      });
    }
  }

  return out;
}

/**
 * Fetch uncached/stale prices from Steam, rate-limited.
 * Calls `onPrice(entry)` after each successful fetch so the UI can update live.
 * Call this AFTER getCachedPrices() to fill in missing prices.
 */
export async function fetchLivePrices(
  items: { itemKey: number; name: string }[],
  onPrice: (entry: PriceEntry) => void,
): Promise<void> {
  const cache = loadCache();
  const toFetch: { itemKey: number; name: string }[] = [];

  for (const { itemKey, name } of items) {
    const cached = cache.get(itemKey);
    if (!cached || !isFresh(cached, itemKey)) {
      toFetch.push({ itemKey, name });
    }
  }

  for (let i = 0; i < toFetch.length; i++) {
    const { itemKey, name } = toFetch[i];
    try {
      const entry = await fetchOneFromSteam(itemKey, name);
      // Don't cache null prices for equipment (market can open/close)
      if (!isMaterial(itemKey) && entry.price === null) {
        // Still notify the UI, but don't persist null
        onPrice(entry);
      } else {
        cache.set(itemKey, entry);
        persistCache();
        onPrice(entry);
      }
    } catch {
      // API failure — keep stale cache or null
      const stale = cache.get(itemKey);
      onPrice(stale ?? { itemKey, name, price: null, volume: 0, source: "steam", fetchedAt: 0 });
    }

    if (i < toFetch.length - 1) {
      await new Promise((r) => setTimeout(r, 2100));
    }
  }
}
