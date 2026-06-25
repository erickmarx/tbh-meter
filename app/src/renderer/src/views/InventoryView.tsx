// InventoryView.tsx — visual icon grid of the player's inventory with Steam pricing.
// All items unified in one grid, filterable by type (All / Equipment / Materials).
// Sortable by Price (default) or Grade. Prices stream in via background events.
// Hover tooltip shows item name, ID, grade, level, and price details.

import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, CircleDollarSign, ArrowUpDown } from "lucide-react";
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

// Border tint per grade (subtle colored border)
const GRADE_BORDER: Record<number, string> = {
  9: "border-red-500/40", 8: "border-pink-500/40", 7: "border-cyan-500/40",
  6: "border-violet-500/40", 5: "border-amber-500/40", 4: "border-red-500/30",
  3: "border-orange-500/40", 2: "border-blue-500/40", 1: "border-green-500/40",
  0: "border-surface-600",
};

const GRADE_NAMES: Record<number, string> = {
  9: "COSMIC", 8: "DIVINE", 7: "CELESTIAL", 6: "BEYOND", 5: "ARCANA",
  4: "IMMORTAL", 3: "LEGENDARY", 2: "RARE", 1: "UNCOMMON", 0: "COMMON",
};

type FilterMode = "all" | "equipment" | "materials";
type SortMode = "price" | "grade";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMaterial(it: InventoryItem): boolean {
  return it.itemKey < 300_000 || (it.slotId === 0 && it.gradeId == null);
}

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

function formatTimeAgo(ms: number, t: Translate): string {
  const diffMin = Math.floor((Date.now() - ms) / 60_000);
  if (diffMin < 1) return t("inventory.updatedMin", { n: "<1" });
  if (diffMin < 60) return t("inventory.updatedMin", { n: String(diffMin) });
  const hours = Math.floor(diffMin / 60);
  return hours === 1
    ? t("inventory.updatedHour", { n: "1" })
    : t("inventory.updatedHours", { n: String(hours) });
}

function sortItems(items: InventoryItem[], mode: SortMode): InventoryItem[] {
  return [...items].sort((a, b) => {
    // Tradable items always sort before non-tradable
    const aTradable = isItemTradable(a);
    const bTradable = isItemTradable(b);
    if (aTradable !== bTradable) return aTradable ? -1 : 1;

    if (mode === "grade") {
      const g = (b.gradeId ?? -1) - (a.gradeId ?? -1);
      if (g !== 0) return g;
      const l = (b.level ?? 0) - (a.level ?? 0);
      if (l !== 0) return l;
    }
    // Price sort: total value (count × unit price) descending
    return (b.totalValue ?? 0) - (a.totalValue ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function InventoryView() {
  const { t } = useI18n();
  const [data, setData] = useState<InventorySnapshot | null | "loading" | "error">("loading");
  const [fetchingCount, setFetchingCount] = useState(0);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [sortBy, setSortBy] = useState<SortMode>("price");

  const allItems = [...(data && data !== "loading" && data !== "error" ? data.inventory ?? [] : []),
                     ...(data && data !== "loading" && data !== "error" ? data.stash ?? [] : [])];

  const handlePriceUpdate = useCallback((update: InventoryPriceUpdate) => {
    setData((prev) => {
      if (!prev || prev === "loading" || prev === "error") return prev;
      if (update.allDone) {
        setFetchingCount(0);
        return { ...prev, priceSource: "mixed" as const, pricesFetchedAt: update.fetchedAt || prev.pricesFetchedAt };
      }
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
      const all = [...(newInventory ?? []), ...(newStash ?? [])];
      const withPrice = all.filter((it) => it.price != null);
      return {
        ...prev, inventory: newInventory, stash: newStash,
        grandTotal: +withPrice.filter((it) => it.totalValue != null).reduce((s, it) => s + (it.totalValue ?? 0), 0).toFixed(2),
        pricedCount: withPrice.length,
        unpricedCount: all.length - withPrice.length,
        pricesFetchedAt: update.fetchedAt || prev.pricesFetchedAt,
      };
    });
    if (!update.allDone) setFetchingCount((n) => n - 1);
  }, []);

  useEffect(() => {
    setData("loading");
    window.meter.getInventory()
      .then((d) => {
        if (d) {
          const all = [...(d.inventory ?? []), ...(d.stash ?? [])];
          setFetchingCount(all.filter((it) => it.price == null).length);
        }
        setData(d ?? "error");
      })
      .catch(() => setData("error"));
    return window.meter.onInventoryPrices(handlePriceUpdate);
  }, [handlePriceUpdate]);

  if (data === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
        <Loader2 className="size-4 animate-spin" />{t("inventory.loading")}
      </div>
    );
  }
  if (data === "error" || data === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
        <p className="text-sm text-red-400">{t("inventory.noData")}</p>
        <p className="text-center text-xs text-zinc-600">{t("inventory.noDataHint")}</p>
      </div>
    );
  }

  const filtered = allItems.filter((it) => {
    if (filter === "equipment") return !isMaterial(it);
    if (filter === "materials") return isMaterial(it);
    return true;
  });
  const sorted = sortItems(filtered, sortBy);
  const hasPrices = data.pricedCount > 0;
  const freshness = data.pricesFetchedAt != null
    ? Date.now() - data.pricesFetchedAt < 60 * 60 * 1000 ? "live" as const
    : Date.now() - data.pricesFetchedAt < 24 * 60 * 60 * 1000 ? "cached" as const
    : "stale" as const
    : null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="shrink-0 border-b border-surface-600 bg-surface-800/80 px-4 py-3">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-bold text-white">{t("inventory.title")}</h1>
          {hasPrices && (
            <div className="flex items-baseline gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">{t("inventory.totalValue")}</span>
              <span className="text-lg font-bold tabular-nums text-emerald-400">${data.grandTotal.toFixed(2)}</span>
            </div>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[10px] text-zinc-500">
          <span>{t("inventory.pricedCount", { priced: String(data.pricedCount), total: String(data.pricedCount + data.unpricedCount) })}</span>
          {fetchingCount > 0 && (
            <span className="flex items-center gap-1 text-zinc-400">
              <Loader2 className="size-2.5 animate-spin" />{t("inventory.fetchingN", { n: String(fetchingCount) })}
            </span>
          )}
          {freshness && fetchingCount === 0 && (
            <span className="flex items-center gap-1">
              {freshness === "live" && <CircleDollarSign className="size-3 text-emerald-500" />}
              <span className={freshness === "live" ? "text-emerald-500" : freshness === "cached" ? "text-zinc-500" : "text-amber-500"}>
                {freshness === "live" ? t("inventory.priceLive") : freshness === "cached" ? t("inventory.priceCached") : t("inventory.priceStale")}
              </span>
              <span className="text-zinc-600">· {t("inventory.updatedAgo", { time: formatTimeAgo(data.pricesFetchedAt!, t) })}</span>
            </span>
          )}
          <span className="text-zinc-600">{data.source === "live" ? t("inventory.sourceLive") : t("inventory.sourceRaw")}</span>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 border-b border-surface-600 px-4 py-1.5">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label="All" />
        <FilterChip active={filter === "equipment"} onClick={() => setFilter("equipment")} label="Equipment" />
        <FilterChip active={filter === "materials"} onClick={() => setFilter("materials")} label="Materials" />
        <span className="ml-1 text-[10px] tabular-nums text-zinc-600">({sorted.length})</span>
        <button
          onClick={() => setSortBy((s) => (s === "price" ? "grade" : "price"))}
          className="ml-auto flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors hover:bg-surface-700 hover:text-zinc-300"
          title={sortBy === "price" ? "Currently sorted by price. Click to sort by grade." : "Currently sorted by grade. Click to sort by price."}
        >
          <ArrowUpDown className="size-3" />
          Sort: {sortBy === "price" ? "Price" : "Grade"}
        </button>
      </div>

      {/* ── Grid ── */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {sorted.length === 0 ? (
          <p className="py-2 text-xs text-zinc-600">{t("inventory.empty")}</p>
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))" }}>
            {sorted.map((it, i) => (
              <ItemCard key={`${it.itemKey}-${i}`} item={it} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter chip
// ---------------------------------------------------------------------------

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
        active ? "bg-surface-700 text-white" : "text-zinc-500 hover:bg-surface-700 hover:text-zinc-300",
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Item card
// ---------------------------------------------------------------------------

function ItemCard({ item }: { item: InventoryItem }) {
  const material = isMaterial(item);
  const tradable = isItemTradable(item);
  const gradeBorder = item.gradeId != null ? (GRADE_BORDER[item.gradeId] ?? "") : "";
  const gradeName = item.gradeId != null ? (GRADE_NAMES[item.gradeId] ?? "") : "";
  const { open, anchorRef, hover } = useHoverTooltip<HTMLDivElement>();
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [tooltipAbove, setTooltipAbove] = useState(true);

  const handleEnter = (): void => {
    openTimer.current = setTimeout(() => {
      // Check if card is near top of viewport → flip tooltip below
      if (cardRef.current) {
        const rect = cardRef.current.getBoundingClientRect();
        setTooltipAbove(rect.top > 120);
      }
      hover(true);
    }, 300);
  };

  const handleLeave = (): void => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    hover(false);
  };

  return (
    <div
      ref={(node) => {
        (anchorRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        (cardRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }}
      className={cn(
        "relative flex flex-col items-center rounded-lg border bg-surface-800/60 p-1.5",
        "transition-colors hover:bg-surface-800",
        gradeBorder || "border-surface-600",
        !tradable && "opacity-50",
      )}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {material && item.count > 1 && (
        <span className="absolute right-1 top-1 rounded bg-surface-700 px-1 text-[10px] font-bold tabular-nums text-zinc-300">
          ×{item.count}
        </span>
      )}
      <span className="my-1 text-2xl leading-none opacity-80">{spriteEmoji(item)}</span>
      <div className="mt-auto flex w-full items-end justify-end gap-1">
        {!material && item.level != null && (
          <span className="text-[9px] tabular-nums leading-tight text-zinc-500">Lv{item.level}</span>
        )}
        <div className="ml-auto flex flex-col items-end">
          {item.totalValue != null ? (
            <span className="rounded bg-emerald-500/10 px-1 text-[10px] font-bold tabular-nums leading-tight text-emerald-400">
              ${item.totalValue.toFixed(2)}
            </span>
          ) : (
            <span className="text-[10px] tabular-nums leading-tight text-zinc-600">—</span>
          )}
        </div>
      </div>
      {open && (
        <div
          className={cn(
            "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 rounded-md border border-surface-500/70 bg-surface-800/95 px-2.5 py-1.5 shadow-xl backdrop-blur",
            tooltipAbove ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          <ItemTooltip item={item} material={material} tradable={tradable} gradeName={gradeName} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item tooltip
// ---------------------------------------------------------------------------

function ItemTooltip({
  item, material, tradable, gradeName,
}: {
  item: InventoryItem; material: boolean; tradable: boolean; gradeName: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 text-xs whitespace-nowrap">
      <span className="font-semibold text-zinc-100">{item.name}</span>
      <span className="text-[9px] text-zinc-600">ID: {item.itemKey}</span>
      {material && (
        <>
          <span className="text-zinc-400">
            ×{item.count}
            {item.price != null && <> · ${item.price.toFixed(2)} ea</>}
            {item.totalValue != null && <> · <span className="text-emerald-400">${item.totalValue.toFixed(2)} total</span></>}
          </span>
          {item.volume > 0 && <span className="text-zinc-500">Vol: {item.volume.toLocaleString()} (24h)</span>}
        </>
      )}
      {!material && (
        <>
          <span className="text-zinc-400">
            {gradeName && <>{gradeName}</>}
            {item.level != null && <> · Lv {item.level}</>}
          </span>
          {tradable && item.price != null && <span className="font-bold text-emerald-400">${item.price.toFixed(2)}</span>}
          {tradable && item.volume > 0 && <span className="text-zinc-500">Vol: {item.volume.toLocaleString()} (24h)</span>}
          {!tradable && <span className="italic text-zinc-500">Not tradable</span>}
        </>
      )}
      {tradable && item.price == null && <span className="text-zinc-500">No active listings</span>}
    </div>
  );
}
