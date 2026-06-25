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

class SteamRateLimitError extends Error {
  constructor() { super("Steam rate limited"); }
}

function isMaterial(itemKey: number): boolean {
  return itemKey < 300_000;
}
function isFresh(cached: PriceEntry, _itemKey: number): boolean {
  // Null price is never "fresh" — always re-fetch (market can open, previous cache was wrong, etc.)
  if (cached.price === null) return false;
  const ttl = isMaterial(_itemKey) ? MATERIAL_TTL_MS : EQUIPMENT_TTL_MS;
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
// Steam Community Market (fallback)
// ---------------------------------------------------------------------------

/** Grade name used in Steam market_hash_name suffix (e.g. " (Arcana)"). */
const STEAM_GRADE_SUFFIX: Record<number, string> = {
  9: " (Cosmic)",
  8: " (Divine)",
  7: " (Celestial)",
  6: " (Beyond)",
  5: " (Arcana)",
  4: " (Immortal)",
  3: " (Legendary)",
  2: " (Rare)",
  1: " (Uncommon)",
  0: " (Common)",
};

/**
 * Try Steam priceoverview with one or more name variants.
 * Equipment items need the grade suffix (e.g. "Elite Bow (Arcana) A").
 * We try bare name first, then name + grade suffix, then with variant letters A/B/C.
 */
async function fetchOneFromSteam(itemKey: number, name: string, gradeId: number | null): Promise<PriceEntry | null> {
  const candidates: string[] = [name];

  // Equipment: also try with grade suffix
  if (itemKey >= 300_000 && gradeId != null) {
    const suffix = STEAM_GRADE_SUFFIX[gradeId] ?? "";
    if (suffix) {
      candidates.push(`${name}${suffix}`);
      // Try common variant letters
      for (const letter of ["A", "B", "C"]) {
        candidates.push(`${name}${suffix} ${letter}`);
      }
    }
  }

  for (const marketName of candidates) {
    const encoded = encodeURIComponent(marketName);
    const url = `https://steamcommunity.com/market/priceoverview/?appid=3678970&currency=1&market_hash_name=${encoded}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
    } catch (err) {
      console.log(`[steam-prices] Steam fetch error: "${marketName}" — ${err}`);
      continue;
    }

    if (!res.ok) {
      console.log(`[steam-prices] Steam HTTP ${res.status} for "${marketName}"`);
      if (res.status === 429) throw new SteamRateLimitError();
      continue;
    }

    const data = (await res.json()) as {
      success: boolean;
      lowest_price?: string;
      median_price?: string;
      volume?: string;
    };

    if (!data.success) {
      console.log(`[steam-prices] Steam !success for "${marketName}"`);
      continue;
    }

    const price = parseSteamPrice(data.median_price ?? data.lowest_price);
    if (price == null) {
      console.log(`[steam-prices] Steam no-price for "${marketName}": ${JSON.stringify(data)}`);
      continue;
    }

    console.log(`[steam-prices] Steam OK: "${marketName}" → $${price}`);
    return {
      itemKey, name: marketName, price,
      volume: parseSteamVolume(data.volume),
      source: "steam",
      fetchedAt: Date.now(),
    };
  }

  return null;
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
  const apiMissed: { itemKey: number; name: string; gradeId: number | null }[] = [];

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

      // Track items the API didn't return → try Steam fallback
      for (const itemKey of batch) {
        if (!results.has(itemKey)) {
          const name = nameMap.get(itemKey) ?? "";
          const gradeId = toFetch.find((it) => it.itemKey === itemKey)?.gradeId ?? null;
          apiMissed.push({ itemKey, name, gradeId });
        }
      }
    } catch {
      // API failure → all items in batch go to Steam fallback
      console.error(`[steam-prices] TBH API failed for batch (${batch.length} keys), falling back to Steam`);
      for (const itemKey of batch) {
        const name = nameMap.get(itemKey) ?? "";
        apiMissed.push({ itemKey, name, gradeId: null });
      }
    }
  }

  // Phase 2: Steam fallback for items the API missed
  // Individual priceoverview calls are rate-limited aggressively. On 429, we
  // back off exponentially and abort after 3 consecutive failures.
  let consecutive429 = 0;
  for (let i = 0; i < apiMissed.length; i++) {
    const { itemKey, name, gradeId } = apiMissed[i];
    let steamEntry: PriceEntry | null = null;

    try {
      steamEntry = await fetchOneFromSteam(itemKey, name, gradeId);
    } catch (err) {
      if (err instanceof SteamRateLimitError) {
        consecutive429++;
        if (consecutive429 >= 3) {
          console.warn(`[steam-prices] Aborting Steam fallback after ${consecutive429} consecutive 429s (${apiMissed.length - i} items skipped)`);
          for (let j = i; j < apiMissed.length; j++) {
            const skipped = apiMissed[j];
            onPrice({ itemKey: skipped.itemKey, name: skipped.name, price: null, volume: 0, source: "steam", fetchedAt: Date.now() });
          }
          return;
        }
        // Wait and retry
        const backoff = consecutive429 * 10_000;
        console.log(`[steam-prices] 429 #${consecutive429}, waiting ${backoff / 1000}s before retry...`);
        await new Promise((r) => setTimeout(r, backoff));
        try {
          steamEntry = await fetchOneFromSteam(itemKey, name, gradeId);
          consecutive429 = 0;
        } catch (err2) {
          if (err2 instanceof SteamRateLimitError) {
            consecutive429++;
          }
        }
      }
    }

    if (steamEntry) {
      consecutive429 = 0;
      console.log(`[steam-prices] Steam OK: ${name} (${itemKey}) → $${steamEntry.price}`);
      cache.set(itemKey, steamEntry);
      persistCache();
      onPrice(steamEntry);
    } else {
      onPrice({
        itemKey, name, price: null, volume: 0, source: "steam", fetchedAt: Date.now(),
      });
    }

    // Normal rate-limit delay
    if (i < apiMissed.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
