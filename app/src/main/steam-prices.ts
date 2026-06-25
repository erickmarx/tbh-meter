// steam-prices.ts — fetch item prices for tradable items only.
// Primary: TBH API /steam/prices (itemKeys, batched, no name mapping needed).
// Fallback: Steam Community Market priceoverview (bare name from items-min.json).
// Materials: 1h cache TTL. Equipment: 6h. Null prices never cached for equipment.
// Cache at ~/tbh-meter/prices.json.

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { API_URL } from "./config.js";
import { getAccessToken } from "./auth.js";

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
  return gradeId != null && gradeId >= 5;                   // equipment: Legendary+
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

function isFresh(cached: PriceEntry, itemKey: number): boolean {
  const ttl = isMaterial(itemKey) ? MATERIAL_TTL_MS : EQUIPMENT_TTL_MS;
  if (!isMaterial(itemKey) && cached.price === null) return false;
  return Date.now() - cached.fetchedAt < ttl;
}

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

// ---------------------------------------------------------------------------
// TBH API (primary)
// ---------------------------------------------------------------------------

const MAX_KEYS_PER_BATCH = 100;

async function fetchBatchFromApi(itemKeys: number[]): Promise<Map<number, PriceEntry>> {
  const out = new Map<number, PriceEntry>();
  if (itemKeys.length === 0) return out;

  const keysParam = itemKeys.join(",");
  const url = `${API_URL}/steam/prices?keys=${encodeURIComponent(keysParam)}`;

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
// Steam Community Market (fallback)
// ---------------------------------------------------------------------------

/** Try Steam priceoverview directly. Only called for tradable items the API missed. */
async function fetchOneFromSteam(itemKey: number, name: string): Promise<PriceEntry | null> {
  const encoded = encodeURIComponent(name);
  const url = `https://steamcommunity.com/market/priceoverview/?appid=3678970&currency=1&market_hash_name=${encoded}`;

  let res: Response;
  try { res = await fetch(url); }
  catch { return null; }

  if (!res.ok) return null;

  const data = (await res.json()) as {
    success: boolean;
    lowest_price?: string;
    median_price?: string;
    volume?: string;
  };

  if (!data.success) return null;

  const price = parseSteamPrice(data.median_price ?? data.lowest_price);
  if (price == null) return null; // no listings

  return {
    itemKey, name, price,
    volume: parseSteamVolume(data.volume),
    source: "steam",
    fetchedAt: Date.now(),
  };
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
  items: { itemKey: number; name: string }[],
  onPrice: (entry: PriceEntry) => void,
): Promise<void> {
  const cache = loadCache();
  const toFetch: { itemKey: number; name: string }[] = [];

  for (const it of items) {
    const cached = cache.get(it.itemKey);
    if (!cached || !isFresh(cached, it.itemKey)) {
      toFetch.push(it);
    }
  }

  if (toFetch.length === 0) return;

  // Phase 1: TBH API (batched, fast)
  const apiKeys = toFetch.map((it) => it.itemKey);
  const nameMap = new Map(toFetch.map((it) => [it.itemKey, it.name]));
  const apiMissed: { itemKey: number; name: string }[] = [];

  for (let i = 0; i < apiKeys.length; i += MAX_KEYS_PER_BATCH) {
    const batch = apiKeys.slice(i, i + MAX_KEYS_PER_BATCH);
    try {
      const results = await fetchBatchFromApi(batch);

      for (const [itemKey, entry] of results) {
        entry.name = nameMap.get(itemKey) ?? "";
        if (!isMaterial(itemKey) && entry.price === null) {
          onPrice(entry); // equipment null: notify but don't cache
        } else {
          cache.set(itemKey, entry);
          persistCache();
          onPrice(entry);
        }
      }

      // Track items the API didn't return → try Steam fallback
      for (const itemKey of batch) {
        if (!results.has(itemKey)) {
          const name = nameMap.get(itemKey) ?? "";
          apiMissed.push({ itemKey, name });
        }
      }
    } catch {
      // API failure → all items in batch go to Steam fallback
      for (const itemKey of batch) {
        const name = nameMap.get(itemKey) ?? "";
        apiMissed.push({ itemKey, name });
      }
    }
  }

  // Phase 2: Steam fallback for items the API missed (rate-limited, 1 by 1)
  for (let i = 0; i < apiMissed.length; i++) {
    const { itemKey, name } = apiMissed[i];
    const steamEntry = await fetchOneFromSteam(itemKey, name);

    if (steamEntry) {
      cache.set(itemKey, steamEntry);
      persistCache();
      onPrice(steamEntry);
    } else {
      // No price from either source
      const nullEntry: PriceEntry = {
        itemKey, name, price: null, volume: 0, source: "steam", fetchedAt: Date.now(),
      };
      if (isMaterial(itemKey)) {
        cache.set(itemKey, nullEntry);
        persistCache();
      }
      // equipment null: never cached
      onPrice(nullEntry);
    }

    // Rate-limit Steam API
    if (i < apiMissed.length - 1) {
      await new Promise((r) => setTimeout(r, 2100));
    }
  }
}
