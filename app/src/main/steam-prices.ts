// steam-prices.ts — fetch item prices for tradable items only.
// Primary: TBH API /steam/prices (itemKeys, batched, no name mapping needed).
// Fallback: Steam Community Market priceoverview (bare name from items-min.json).
// Materials: 1h cache TTL. Equipment: 6h. Null prices never cached for equipment.
// Cache at ~/tbh-meter/prices.json.

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getAccessToken } from "./auth.js";

/** Steam prices always use the production API — the local dev server may not have /steam/prices. */
const STEAM_API_URL = "https://api.tbherohelper.com";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriceEntry {
  itemKey: number;
  name: string;
  price: number | null;
  volume: number;
  source: "api" | "steam" | "cache";
  fetchedAt: number;
}

interface ApiPriceResponse {
  [itemKey: string]: {
    lowestCents?: number | null;
    medianCents?: number | null;
    volume?: number;
    fetchedAt?: string;
  };
}

// ---------------------------------------------------------------------------
// Tradable check
// ---------------------------------------------------------------------------

/**
 * An item is tradable on the Steam Market when:
 * - Materials (itemKey < 300k): always tradable
 * - Equipment: only Legendary grade (gradeId >= 5) — per the game operator
 * Items without a gradeId (agent path) are treated as NOT tradable for equipment.
 */
export function isTradable(itemKey: number, gradeId: number | null): boolean {
  if (itemKey < 300_000) return true;                      // materials
  return gradeId != null && gradeId >= 3;                   // equipment: LEGENDARY+
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const MATERIAL_TTL_MS = 60 * 60 * 1000;
const EQUIPMENT_TTL_MS = 6 * 60 * 60 * 1000;

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
      for (const [k, v] of Object.entries(raw)) _cache.set(Number(k), v);
    }
  } catch { /* corrupt → fresh */ }
  return _cache;
}

function persistCache(): void {
  const obj: Record<string, PriceEntry> = {};
  for (const [k, v] of loadCache()) obj[String(k)] = v;
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
function isFresh(cached: PriceEntry, _itemKey: number): boolean {
  // Null price is never "fresh" — always re-fetch (market can open, previous cache was wrong, etc.)
  if (cached.price === null) return false;
  const ttl = isMaterial(_itemKey) ? MATERIAL_TTL_MS : EQUIPMENT_TTL_MS;
  return Date.now() - cached.fetchedAt < ttl;
}

// ---------------------------------------------------------------------------
// TBH API (primary)
// ---------------------------------------------------------------------------

const MAX_KEYS_PER_BATCH = 100;

async function fetchBatchFromApi(itemKeys: number[]): Promise<Map<number, PriceEntry>> {
  const out = new Map<number, PriceEntry>();
  if (itemKeys.length === 0) return out;

  const keysParam = itemKeys.join(",");
  const url = `${STEAM_API_URL}/steam/prices?keys=${encodeURIComponent(keysParam)}`;

  const token = await getAccessToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try { res = await fetch(url, { headers }); }
  catch { throw new Error("TBH API fetch failed"); }

  if (!res.ok) throw new Error(`TBH API returned ${res.status}`);

  const data = (await res.json()) as ApiPriceResponse;

  for (const [keyStr, entry] of Object.entries(data)) {
    const itemKey = Number(keyStr);
    const cents = entry.medianCents ?? entry.lowestCents;
    out.set(itemKey, {
      itemKey, name: "",
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

export async function fetchLivePrices(
  items: { itemKey: number; name: string; gradeId?: number | null }[],
  onPrice: (entry: PriceEntry) => void,
): Promise<void> {
  const cache = loadCache();
  const toFetch: { itemKey: number; name: string; gradeId: number | null }[] = [];

  for (const it of items) {
    const cached = cache.get(it.itemKey);
    if (!cached || !isFresh(cached, it.itemKey)) {
      toFetch.push({ itemKey: it.itemKey, name: it.name, gradeId: it.gradeId ?? null });
    }
  }

  if (toFetch.length === 0) return;

  // Phase 1: TBH API (batched, fast)
  const apiKeys = toFetch.map((it) => it.itemKey);
  const nameMap = new Map(toFetch.map((it) => [it.itemKey, it.name]));

  for (let i = 0; i < apiKeys.length; i += MAX_KEYS_PER_BATCH) {
    const batch = apiKeys.slice(i, i + MAX_KEYS_PER_BATCH);
    try {
      const results = await fetchBatchFromApi(batch);

      for (const [itemKey, entry] of results) {
        entry.name = nameMap.get(itemKey) ?? "";
        if (entry.price === null) {
          onPrice(entry); // null: notify but don't cache
        } else {
          cache.set(itemKey, entry);
          persistCache();
          onPrice(entry);
        }
      }

      // Track items the API didn't return — notify as unavailable.
      // Steam individual priceoverview is too rate-limited to use as fallback.
      // Items will get prices when the TBH API cache updates (or on next tab open).
      for (const itemKey of batch) {
        if (!results.has(itemKey)) {
          const name = nameMap.get(itemKey) ?? "";
          onPrice({ itemKey, name, price: null, volume: 0, source: "api", fetchedAt: Date.now() });
        }
      }
    } catch {
      // API failure → notify all items in batch as unavailable
      console.error(`[steam-prices] TBH API failed for batch (${batch.length} keys)`);
      for (const itemKey of batch) {
        const name = nameMap.get(itemKey) ?? "";
        onPrice({ itemKey, name, price: null, volume: 0, source: "api", fetchedAt: Date.now() });
      }
    }
  }
}
