// steam-prices.ts — fetch item prices from the TBH API (api.tbherohelper.com).
// The API accepts itemKeys directly — no market_hash_name mapping needed.
// Prices returned as medianCents (divide by 100 for USD).
// Materials: 1h cache TTL. Equipment: 6h. Equipment with cached null price is
// never served from cache (market can open/close).
// Cache at ~/tbh-meter/prices.json.

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { API_URL } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriceEntry {
  itemKey: number;
  name: string;
  /** USD price, or null when the item has no active Steam listings. */
  price: number | null;
  /** 24h volume on Steam market. */
  volume: number;
  /** Where the price came from. */
  source: "api" | "cache";
  /** Unix ms when this entry was last fetched. */
  fetchedAt: number;
}

/** Response shape: { [itemKey]: { medianCents, volume, ... } } */
interface ApiPriceResponse {
  [itemKey: string]: {
    lowestCents?: number | null;
    medianCents?: number | null;
    volume?: number;
    fetchedAt?: string;
  };
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
// TBH API fetch
// ---------------------------------------------------------------------------

/** Max keys per API request (the endpoint caps at 100). */
const MAX_KEYS_PER_BATCH = 100;

async function fetchBatchFromApi(
  itemKeys: number[],
): Promise<Map<number, PriceEntry>> {
  const out = new Map<number, PriceEntry>();
  if (itemKeys.length === 0) return out;

  const keysParam = itemKeys.join(",");
  const url = `${API_URL}/steam/prices?keys=${encodeURIComponent(keysParam)}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(`TBH API fetch failed`);
  }

  if (!res.ok) throw new Error(`TBH API returned ${res.status}`);

  const data = (await res.json()) as ApiPriceResponse;

  for (const [keyStr, entry] of Object.entries(data)) {
    const itemKey = Number(keyStr);
    const cents = entry.medianCents ?? entry.lowestCents;
    out.set(itemKey, {
      itemKey,
      name: "",
      price: cents != null ? +(cents / 100).toFixed(2) : null,
      volume: entry.volume ?? 0,
      source: "api",
      fetchedAt: entry.fetchedAt ? new Date(entry.fetchedAt).getTime() : Date.now(),
    });
  }

  return out;
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
      out.set(itemKey, {
        itemKey, name,
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
 * Fetch fresh prices from the TBH API for items that aren't in cache or are stale.
 * Batched in groups of 100 keys — no per-request delay needed (the API handles
 * Steam rate limits server-side). Calls `onPrice(entry)` after each batch completes.
 */
export async function fetchLivePrices(
  items: { itemKey: number; name: string }[],
  onPrice: (entry: PriceEntry) => void,
): Promise<void> {
  const cache = loadCache();
  const toFetch: number[] = [];

  for (const { itemKey } of items) {
    const cached = cache.get(itemKey);
    if (!cached || !isFresh(cached, itemKey)) {
      toFetch.push(itemKey);
    }
  }

  // Batch in groups of MAX_KEYS_PER_BATCH
  for (let i = 0; i < toFetch.length; i += MAX_KEYS_PER_BATCH) {
    const batch = toFetch.slice(i, i + MAX_KEYS_PER_BATCH);
    try {
      const results = await fetchBatchFromApi(batch);

      for (const [itemKey, entry] of results) {
        // Don't cache null prices for equipment
        if (!isMaterial(itemKey) && entry.price === null) {
          onPrice(entry);
        } else {
          cache.set(itemKey, entry);
          persistCache();
          onPrice(entry);
        }
      }

      // Also notify for items NOT in the API response (no market data)
      for (const itemKey of batch) {
        if (!results.has(itemKey)) {
          const name = items.find((it) => it.itemKey === itemKey)?.name ?? "";
          const nullEntry: PriceEntry = {
            itemKey, name, price: null, volume: 0, source: "api", fetchedAt: Date.now(),
          };
          if (isMaterial(itemKey)) {
            // Materials without price → API issue, don't cache null
            onPrice(nullEntry);
          } else {
            // Equipment without price → not on market, don't cache
            onPrice(nullEntry);
          }
        }
      }
    } catch {
      // API failure — serve stale cache or null for all items in batch
      for (const itemKey of batch) {
        const stale = cache.get(itemKey);
        const name = items.find((it) => it.itemKey === itemKey)?.name ?? "";
        onPrice(stale ?? { itemKey, name, price: null, volume: 0, source: "api", fetchedAt: 0 });
      }
    }
  }
}
