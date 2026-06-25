// InventoryView.tsx — visual icon grid of the player's inventory with Steam pricing.
// Inventory + stash unified, separated only by category (Materials / Equipment).
// Prices load in two phases: cached immediately from local JSON, then live Steam
// prices stream in via background events and update cards in-place.
// Item names intentionally omitted — will appear elsewhere in a future release.

import { useState, useEffect, useCallback } from "react";
import { Loader2, CircleDollarSign } from "lucide-react";
import { useHoverTooltip } from "~/lib/use-hover-tooltip";
import type {
  InventorySnapshot,
  InventoryItem,
  InventoryPriceUpdate,
} from "../../../shared/ipc-types.js";
import type { Translate } from "../../../shared/i18n/index.js";
import { useI18n } from "~/lib/i18n";
import { cn } from "~/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRADE_COLORS: Record<number, string> = {
  9: "bg-red-500/10 text-red-400 ring-red-500/30",          // COSMIC
  8: "bg-pink-500/10 text-pink-400 ring-pink-500/30",       // DIVINE
  7: "bg-cyan-500/10 text-cyan-400 ring-cyan-500/30",       // CELESTIAL
  6: "bg-violet-500/10 text-violet-400 ring-violet-500/30", // BEYOND
  5: "bg-amber-500/10 text-amber-400 ring-amber-500/30",    // ARCANA
  4: "bg-red-500/10 text-red-300 ring-red-500/30",          // IMMORTAL
  3: "bg-orange-500/10 text-orange-400 ring-orange-500/30", // LEGENDARY
  2: "bg-blue-500/10 text-blue-400 ring-blue-500/30",       // RARE
  1: "bg-green-500/10 text-green-400 ring-green-500/30",    // UNCOMMON
  0: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/30",       // COMMON
};

const GRADE_LABELS: Record<number, string> = {
  9: "COS", 8: "DIV", 7: "CEL", 6: "BEY", 5: "ARC",
  4: "IMM", 3: "LEG", 2: "RAR", 1: "UNC", 0: "COM",
};

const GRADE_NAMES: Record<number, string> = {
  9: "COSMIC", 8: "DIVINE", 7: "CELESTIAL", 6: "BEYOND", 5: "ARCANA",
  4: "IMMORTAL", 3: "LEGENDARY", 2: "RARE", 1: "UNCOMMON", 0: "COMMON",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMaterial(it: InventoryItem): boolean {
  return it.itemKey < 300_000 || (it.slotId === 0 && it.gradeId == null);
}

/** Materials always tradable. Equipment only LEGENDARY+ (gradeId >= 3). */
function isItemTradable(it: InventoryItem): boolean {
  if (it.itemKey < 300_000) return true;
  return it.gradeId != null && it.gradeId >= 3;
}

function spriteEmoji(it: InventoryItem): string {
  if (isMaterial(it)) return "💎";
  if (it.slotId === 1) return "🗡️";
  if (it.slotId === 6) return "🛡️";
  if (it.slotId === 2) return "🏹";
  if (it.slotId === 3) return "📿";
  if (it.slotId === 4) return "💍";
  return "⚔️";
}

function computeGrandTotal(items: InventoryItem[]): number {
  return +items
    .filter((it) => it.totalValue != null)
    .reduce((s, it) => s + (it.totalValue ?? 0), 0)
    .toFixed(2);
}

function formatTimeAgo(ms: number, t: Translate): string {
  const diffMin = Math.floor((Date.now() - ms) / 60_000);
  if (diffMin < 1) return t("inventory.updatedMin", { n: "<1" });
  if (diffMin < 60) return t("inventory.updatedMin", { n: String(diffMin) });
  const hours = Math.floor(diffMin / 60);
  return hours === 1
    ? t("inventory.updatedHour", { n: "1" })
    : t("inventory.updatedHours", { n: String(hours) });
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function InventoryView() {
  const { t } = useI18n();
  const [data, setData] = useState<InventorySnapshot | null | "loading" | "error">("loading");
  const [fetchingCount, setFetchingCount] = useState(0);

  // Merge inventory + stash into one list
  const allItems = [...(data && data !== "loading" && data !== "error" ? data.inventory ?? [] : []),
                     ...(data && data !== "loading" && data !== "error" ? data.stash ?? [] : [])];

  // Listen for live price updates from background Steam fetches
  const handlePriceUpdate = useCallback((update: InventoryPriceUpdate) => {
    setData((prev) => {
      if (!prev || prev === "loading" || prev === "error") return prev;

      if (update.allDone) {
        setFetchingCount(0);
        return {
          ...prev,
          priceSource: "mixed" as const,
          pricesFetchedAt: update.fetchedAt || prev.pricesFetchedAt,
        };
      }

      // Apply the price update to matching items
      const applyPrice = (items: InventoryItem[] | null): InventoryItem[] | null => {
        if (!items) return items;
        return items.map((it) => {
          if (it.itemKey !== update.itemKey) return it;
          const price = update.price;
          const totalValue = price != null ? +(price * it.count).toFixed(2) : null;
          return { ...it, price, volume: update.volume, totalValue };
        });
      };

      const newInventory = applyPrice(prev.inventory);
      const newStash = applyPrice(prev.stash);

      const allPriced = [...(newInventory ?? []), ...(newStash ?? [])];
      const withPrice = allPriced.filter((it) => it.price != null);

      return {
        ...prev,
        inventory: newInventory,
        stash: newStash,
        grandTotal: computeGrandTotal(allPriced),
        pricedCount: withPrice.length,
        unpricedCount: allPriced.length - withPrice.length,
        pricesFetchedAt: update.fetchedAt || prev.pricesFetchedAt,
      };
    });

    if (!update.allDone) {
      setFetchingCount((n) => n - 1);
    }
  }, []);

  useEffect(() => {
    setData("loading");
    window.meter
      .getInventory()
      .then((d) => {
        if (d) {
          // Count items that need live fetching (no cached price)
          const all = [...(d.inventory ?? []), ...(d.stash ?? [])];
          const stale = all.filter((it) => it.price == null).length;
          setFetchingCount(stale);
        }
        setData(d ?? "error");
      })
      .catch(() => setData("error"));

    const unsub = window.meter.onInventoryPrices(handlePriceUpdate);
    return unsub;
  }, [handlePriceUpdate]);

  // ── Loading ──
  if (data === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
        <Loader2 className="size-4 animate-spin" />
        {t("inventory.loading")}
      </div>
    );
  }

  // ── Error / no data ──
  if (data === "error" || data === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
        <p className="text-sm text-red-400">{t("inventory.noData")}</p>
        <p className="text-center text-xs text-zinc-600">{t("inventory.noDataHint")}</p>
      </div>
    );
  }

  const materials = allItems.filter(isMaterial);
  const equipment = allItems.filter((it) => !isMaterial(it));
  const hasPrices = data.pricedCount > 0;

  const freshness =
    data.pricesFetchedAt != null
      ? Date.now() - data.pricesFetchedAt < 60 * 60 * 1000
        ? ("live" as const)
        : Date.now() - data.pricesFetchedAt < 24 * 60 * 60 * 1000
          ? ("cached" as const)
          : ("stale" as const)
      : null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="shrink-0 border-b border-surface-600 bg-surface-800/80 px-4 py-3">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-bold text-white">{t("inventory.title")}</h1>
          {hasPrices && (
            <div className="flex items-baseline gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("inventory.totalValue")}
              </span>
              <span className="text-lg font-bold tabular-nums text-emerald-400">
                ${data.grandTotal.toFixed(2)}
              </span>
            </div>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[10px] text-zinc-500">
          <span>
            {t("inventory.pricedCount", {
              priced: String(data.pricedCount),
              total: String(data.pricedCount + data.unpricedCount),
            })}
          </span>
          {fetchingCount > 0 && (
            <span className="flex items-center gap-1 text-zinc-400">
              <Loader2 className="size-2.5 animate-spin" />
              {t("inventory.fetchingN", { n: String(fetchingCount) })}
            </span>
          )}
          {freshness && fetchingCount === 0 && (
            <span className="flex items-center gap-1">
              {freshness === "live" && <CircleDollarSign className="size-3 text-emerald-500" />}
              <span
                className={
                  freshness === "live" ? "text-emerald-500"
                  : freshness === "cached" ? "text-zinc-500"
                  : "text-amber-500"
                }
              >
                {freshness === "live" ? t("inventory.priceLive")
                 : freshness === "cached" ? t("inventory.priceCached")
                 : t("inventory.priceStale")}
              </span>
              <span className="text-zinc-600">
                · {t("inventory.updatedAgo", { time: formatTimeAgo(data.pricesFetchedAt!, t) })}
              </span>
            </span>
          )}
          <span className="text-zinc-600">
            {data.source === "live" ? t("inventory.sourceLive") : t("inventory.sourceRaw")}
          </span>
        </div>
      </div>

      {/* ── Body: grid ── */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
        {allItems.length === 0 ? (
          <p className="py-2 text-xs text-zinc-600">{t("inventory.empty")}</p>
        ) : (
          <>
            {materials.length > 0 && (
              <CategoryGrid title={t("inventory.materials")} count={materials.length} items={materials} />
            )}
            {equipment.length > 0 && (
              <CategoryGrid title={t("inventory.equipment")} count={equipment.length} items={equipment} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category grid
// ---------------------------------------------------------------------------

function CategoryGrid({
  title,
  count,
  items,
}: {
  title: string;
  count: number;
  items: InventoryItem[];
}) {
  const sorted = [...items].sort((a, b) => (b.totalValue ?? 0) - (a.totalValue ?? 0));

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {title}
        </span>
        <span className="text-[10px] tabular-nums text-zinc-600">({count})</span>
      </div>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))" }}
      >
        {sorted.map((it, i) => (
          <ItemCard key={`${isMaterial(it) ? "mat" : "eq"}-${it.itemKey}-${i}`} item={it} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item card
// ---------------------------------------------------------------------------

function ItemCard({ item }: { item: InventoryItem }) {
  const material = isMaterial(item);
  const tradable = isItemTradable(item);
  const gradeBadge = item.gradeId != null ? GRADE_COLORS[item.gradeId] : null;
  const gradeLabel = item.gradeId != null ? (GRADE_LABELS[item.gradeId] ?? "") : "";
  const gradeName = item.gradeId != null ? (GRADE_NAMES[item.gradeId] ?? "") : "";
  const { open, anchorRef, hover } = useHoverTooltip<HTMLDivElement>();

  return (
    <div
      ref={anchorRef}
      className={cn(
        "relative flex flex-col items-center rounded-lg border border-surface-600 bg-surface-800/60 p-1.5",
        "transition-colors hover:border-surface-500 hover:bg-surface-800",
        !tradable && "opacity-50",
      )}
      onMouseEnter={() => hover(true)}
      onMouseLeave={() => hover(false)}
    >
      {/* Quantity badge (top-right, materials only) */}
      {material && item.count > 1 && (
        <span className="absolute right-1 top-1 rounded bg-surface-700 px-1 text-[10px] font-bold tabular-nums text-zinc-300">
          ×{item.count}
        </span>
      )}

      {/* Icon (centered) */}
      <span className="my-1 text-2xl leading-none opacity-80">{spriteEmoji(item)}</span>

      {/* Bottom area: rarity+level (left) + price (right) */}
      <div className="mt-auto flex w-full items-end justify-between gap-1">
        <div className="flex flex-col items-start gap-0.5">
          {!material && gradeBadge && (
            <span className={cn("rounded px-1 py-px text-[8px] font-semibold leading-tight ring-1", gradeBadge)}>
              {gradeLabel}
            </span>
          )}
          {!material && item.level != null && (
            <span className="text-[9px] tabular-nums leading-tight text-zinc-500">Lv{item.level}</span>
          )}
        </div>
        <div className="flex flex-col items-end">
          {item.price != null ? (
            <span className="rounded bg-emerald-500/10 px-1 text-[10px] font-bold tabular-nums leading-tight text-emerald-400">
              ${item.price.toFixed(2)}
            </span>
          ) : (
            <span className="text-[10px] tabular-nums leading-tight text-zinc-600">—</span>
          )}
        </div>
      </div>

      {/* Tooltip */}
      {open && (
        <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 rounded-md border border-surface-500/70 bg-surface-800/95 px-2.5 py-1.5 shadow-xl backdrop-blur">
          <ItemTooltip item={item} material={material} tradable={tradable} gradeName={gradeName} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item tooltip (shown on hover)
// ---------------------------------------------------------------------------

function ItemTooltip({
  item,
  material,
  tradable,
  gradeName,
}: {
  item: InventoryItem;
  material: boolean;
  tradable: boolean;
  gradeName: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 text-xs whitespace-nowrap">
      {/* Name */}
      <span className="font-semibold text-zinc-100">{item.name}</span>

      {/* Material details */}
      {material && (
        <>
          <span className="text-zinc-400">
            ×{item.count}
            {item.price != null && (
              <> · ${item.price.toFixed(2)} ea</>
            )}
            {item.totalValue != null && (
              <> · <span className="text-emerald-400">${item.totalValue.toFixed(2)} total</span></>
            )}
          </span>
          {item.volume > 0 && (
            <span className="text-zinc-500">Vol: {item.volume.toLocaleString()} (24h)</span>
          )}
        </>
      )}

      {/* Equipment details */}
      {!material && (
        <>
          <span className="text-zinc-400">
            {gradeName && <>{gradeName}</>}
            {item.level != null && <> · Lv {item.level}</>}
          </span>
          {tradable && item.price != null && (
            <span className="font-bold text-emerald-400">${item.price.toFixed(2)}</span>
          )}
          {tradable && item.volume > 0 && (
            <span className="text-zinc-500">Vol: {item.volume.toLocaleString()} (24h)</span>
          )}
          {!tradable && (
            <span className="italic text-zinc-500">Not tradable</span>
          )}
        </>
      )}

      {/* No price indicator (both types) */}
      {tradable && item.price == null && (
        <span className="text-zinc-500">No active listings</span>
      )}
    </div>
  );
}
