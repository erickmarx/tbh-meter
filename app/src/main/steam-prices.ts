// steam-prices.ts — fetch item prices from Steam Community Market, cached locally.
// Materials (itemKey < 300k): 1h TTL. Equipment: 24h TTL.
// Cache at ~/tbh-meter/prices.json (same dir as raw/logs).

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriceEntry {
  itemKey: number;
  name: string;
  /** USD price, or null when the item exists on Steam but has no active listings. */
  price: number | null;
  /** 24h volume on Steam market (0 when not reported). */
  volume: number;
  /** Where the price came from. */
  source: "steam" | "cache";
  /** Unix ms when this entry was last fetched from Steam. */
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const MATERIAL_TTL_MS = 60 * 60 * 1000; // 1 hour
const EQUIPMENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

/** Clear the in-memory cache (for tests). Does NOT delete the file. */
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
// Public API
// ---------------------------------------------------------------------------

function isMaterial(itemKey: number): boolean {
  return itemKey < 300_000;
}

/**
 * Get the price for one item. Serves from cache when fresh;
 * fetches from Steam on cache miss or expiry.
 */
export async function getItemPrice(itemKey: number, name: string): Promise<PriceEntry> {
  const cache = loadCache();
  const cached = cache.get(itemKey);
  const ttl = isMaterial(itemKey) ? MATERIAL_TTL_MS : EQUIPMENT_TTL_MS;

  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return { ...cached, source: "cache" as const };
  }

  const entry = await fetchOneFromSteam(itemKey, name);
  cache.set(itemKey, entry);
  persistCache();
  return entry;
}

/**
 * Batch-fetch prices for multiple items with rate-limiting (2.1s between requests).
 * Items already in cache (not expired) are returned immediately without API calls.
 * Steam failures → serves stale cache when available, else null-price fallback.
 */
export async function getItemPrices(
  items: { itemKey: number; name: string }[],
): Promise<Map<number, PriceEntry>> {
  const out = new Map<number, PriceEntry>();
  const toFetch: { itemKey: number; name: string }[] = [];
  const cache = loadCache();

  for (const { itemKey, name } of items) {
    const cached = cache.get(itemKey);
    const ttl = isMaterial(itemKey) ? MATERIAL_TTL_MS : EQUIPMENT_TTL_MS;
    if (cached && Date.now() - cached.fetchedAt < ttl) {
      out.set(itemKey, { ...cached, source: "cache" as const });
    } else {
      toFetch.push({ itemKey, name });
    }
  }

  for (let i = 0; i < toFetch.length; i++) {
    const { itemKey, name } = toFetch[i];
    try {
      const entry = await fetchOneFromSteam(itemKey, name);
      cache.set(itemKey, entry);
      out.set(itemKey, entry);
    } catch {
      // API failure → serve stale cache if available, else null-price
      const stale = cache.get(itemKey);
      out.set(
        itemKey,
        stale ?? { itemKey, name, price: null, volume: 0, source: "steam", fetchedAt: 0 },
      );
    }

    // Rate-limit: 2.1s between Steam API calls
    if (i < toFetch.length - 1) {
      await new Promise((r) => setTimeout(r, 2100));
    }
  }

  persistCache();
  return out;
}
