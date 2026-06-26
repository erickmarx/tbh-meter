// InventoryView.tsx — visual icon grid of the player's inventory with Steam pricing.
// All items unified in one grid, filterable by type (All / Equipment / Materials).
// Sortable by Price (default) or Grade. Prices stream in via background events.
// Hover tooltip shows item name, ID, grade, level, and price details.

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
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

// Grade slot background frame sprites — from data/sprites/item_slot/
const GRADE_SLOT: Record<number, string> = {
  0: "Normal", 1: "Uncommon", 2: "Rare", 3: "Legendary", 4: "Immortal",
  5: "Arcana", 6: "Beyond", 7: "Celestial", 8: "Divine", 9: "Cosmic",
};

function gradeSlotSrc(gradeId: number | null): string | undefined {
  if (gradeId == null) return undefined;
  const name = GRADE_SLOT[gradeId];
  return name ? `sprites/item_slot/ItemSlot_${name}.png` : undefined;
}

// Grade hex colors from taskbarhero.wiki/grades (for tooltip styling)
const GRADE_HEX: Record<number, string> = {
  9: "#fcfcfc", 8: "#fce454", 7: "#6ccce4", 6: "#fc246c", 5: "#b40cfc",
  4: "#fc2424", 3: "#fc9c0c", 2: "#0c6cfc", 1: "#54fc0c", 0: "#e4e4e4",
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

// Slot prefix by itemKey range (equipment)
const SLOT_PREFIX: Record<number, string> = {
  30: "SWORD", 31: "BOW", 32: "STAFF", 33: "SCEPTER", 34: "CROSSBOW", 35: "AXE",
  40: "SHIELD", 41: "ARROW", 42: "ORB", 43: "TOME", 44: "BOLT", 45: "HATCHET",
  50: "HELMET", 51: "ARMOR", 52: "GLOVES", 53: "BOOTS",
  60: "AMULET", 61: "EARING", 62: "RING", 63: "BRACER",
};

function spriteSrc(itemKey: number): string {
  if (itemKey <= 0) return "";
  // Equipment: decode variant key → base sprite
  if (itemKey >= 300_000 && itemKey <= 639_999) {
    // Variant encoding: 3SSTBBV → base = 3SS0BB
    const slotPrefix = Math.floor(itemKey / 10000); // 31 for 315171
    const prefix = SLOT_PREFIX[slotPrefix] ?? "Item";
    const baseId = Math.floor((itemKey % 1000) / 10);  // 17 for 315171
    const baseItemKey = slotPrefix * 10000 + baseId;   // 310017
    return `sprites/items/${prefix}_${baseItemKey}.png`;
  }
  // Materials: use exact itemKey
  return `sprites/items/Item_${itemKey}.png`;
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
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, 52px)" }}>
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
  const gradeSlot = gradeSlotSrc(item.gradeId);
  const gradeName = item.gradeId != null ? (GRADE_NAMES[item.gradeId] ?? "") : "";
  const { open, anchorRef, hover } = useHoverTooltip<HTMLDivElement>();
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMouse = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const cardRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);

  const updateTooltipPos = (clientX: number, clientY: number): void => {
    const estW = 180;
    const estH = 80;
    // Offset from cursor: right and down, leaving space for mouse movement
    const rawLeft = clientX + 12;
    const rawTop = clientY + 12;
    // Clamp to viewport
    const left = Math.max(8, Math.min(window.innerWidth - estW - 8, rawLeft));
    const top = Math.max(8, Math.min(window.innerHeight - estH - 8, rawTop));
    setTooltipPos({ left, top });
  };

  const handleEnter = (e: React.MouseEvent): void => {
    setHovered(true);
    lastMouse.current = { x: e.clientX, y: e.clientY };
    openTimer.current = setTimeout(() => {
      updateTooltipPos(lastMouse.current.x, lastMouse.current.y);
      hover(true);
    }, 300);
  };

  const handleMove = (e: React.MouseEvent): void => {
    lastMouse.current = { x: e.clientX, y: e.clientY };
    if (!open) return;
    updateTooltipPos(e.clientX, e.clientY);
  };

  const handleLeave = (): void => {
    setHovered(false);
    setTooltipPos(null);
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
        "relative flex cursor-pointer flex-col items-center justify-center rounded outline outline-1 -outline-offset-1",
        "transition-[transform] duration-100",
        !tradable && "opacity-50",
        hovered && "scale-105",
      )}
      style={{
        width: 52, height: 52, imageRendering: "pixelated",
        backgroundImage: gradeSlot ? `url(${gradeSlot})` : undefined,
        backgroundSize: "100% 100%",
        boxShadow: "3px 3px 0 rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06), inset 0 -1px 0 rgba(0,0,0,0.15)",
      }}
      onMouseEnter={handleEnter}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
    >
      {/* Hover highlight */}
      <div
        className="pointer-events-none absolute inset-0 rounded bg-white/[0.08] opacity-0 transition-opacity duration-100"
        style={{ opacity: hovered ? 1 : 0 }}
      />

      {/* Level — top left */}
      {!material && item.level != null && (
        <span
          className="absolute top-0 left-0 z-10 px-0.5 text-[9px] font-bold leading-none text-zinc-200"
          style={{ textShadow: "0 0 3px rgba(0,0,0,0.8), 0 0 3px rgba(0,0,0,0.8)" }}
        >
          Lv{item.level}
        </span>
      )}

      {/* Quantity badge — top right */}
      {item.count > 1 && (
        <span className="absolute top-0 right-0 z-10 rounded-bl-sm bg-amber-500 px-1 text-[10px] font-black leading-none text-black">
          ×{item.count}
        </span>
      )}

      {/* Icon */}
      <img
        src={spriteSrc(item.itemKey)}
        alt=""
        className="w-[34px] h-[34px] object-contain opacity-90"
        style={{ imageRendering: "pixelated" }}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />

      {/* Price — bottom right */}
      {item.totalValue != null && (
        <span className="absolute bottom-0 right-0 z-10 rounded-tl-sm bg-emerald-500 px-1 text-[9px] font-bold leading-none text-black">
          ${item.totalValue.toFixed(2)}
        </span>
      )}

      {/* Tooltip — portaled to body to avoid overflow clipping */}
      {open && tooltipPos && createPortal(
        <div
          className="fixed pointer-events-none z-[999] rounded-xl px-4 py-3.5 max-w-[calc(100vw-16px)]"
          style={{
            background: item.gradeId != null
              ? `linear-gradient(180deg, ${GRADE_HEX[item.gradeId]}33, #14100bf5 40%)`
              : "#14100bf5",
            border: item.gradeId != null
              ? `1px solid ${GRADE_HEX[item.gradeId]}66`
              : "1px solid rgba(113,113,122,0.3)",
            boxShadow: item.gradeId != null
              ? `
                  0 0 0 1px ${GRADE_HEX[item.gradeId]}22,
                  0 0 24px ${GRADE_HEX[item.gradeId]}25,
                  0 4px 16px rgba(0,0,0,0.5)`
              : "0 4px 16px rgba(0,0,0,0.5)",
            top: tooltipPos.top,
            left: tooltipPos.left,
          }}
        >
          <ItemTooltip item={item} material={material} tradable={tradable} gradeName={gradeName} gradeHex={item.gradeId != null ? GRADE_HEX[item.gradeId] : undefined} />
        </div>,
        document.body,
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item tooltip
// ---------------------------------------------------------------------------

function ItemTooltip({
  item, material, tradable: _tradable, gradeName, gradeHex,
}: {
  item: InventoryItem; material: boolean; tradable: boolean; gradeName: string; gradeHex?: string;
}) {
  const src = spriteSrc(item.itemKey);
  const hex = gradeHex ?? "#888";
  return (
    <div className="flex w-[240px] flex-col gap-2 text-xs" style={{ fontFamily: "Lato-Semibold, 'Segoe UI', sans-serif" }}>
      {/* Sprite + name row */}
      <div className="flex items-center gap-2.5">
        {/* Sprite in grade-framed container */}
        <div
          className="relative flex size-[52px] shrink-0 items-center justify-center overflow-hidden rounded"
          style={{
            border: `1px solid ${hex}44`,
            backgroundImage: `url(sprites/item_slot/ItemSlot_${gradeName}.png)`,
            backgroundSize: "cover",
            imageRendering: "pixelated",
          }}
        >
          <img
            src={src}
            alt=""
            className="size-[38px] object-contain"
            style={{ imageRendering: "pixelated" }}
          />
        </div>
        {/* Name + grade pill */}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-[13px] font-semibold" style={{ color: "#e8dcc0" }}>
            {item.name}
          </span>
          <span
            className="self-start rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wider"
            style={{
              color: hex,
              background: `${hex}18`,
              borderColor: `${hex}33`,
            }}
          >
            {gradeName}
          </span>
        </div>
      </div>

      {/* Level */}
      {!material && item.level != null && (
        <span className="text-[11px]" style={{ color: "#8a6a30" }}>Level {item.level}</span>
      )}

      {/* Divider */}
      <div className="-mx-1 h-px" style={{ background: "#1e1608" }} />

      {/* Pricing */}
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-0.5">
          {item.price != null ? (
            <>
              <span className="text-[11px] uppercase tracking-wider" style={{ color: "#5a4028" }}>Price</span>
              <span className="text-[14px] font-bold" style={{ color: "#ffb347", fontFamily: "monospace" }}>
                ${item.price.toFixed(2)}
              </span>
            </>
          ) : (
            <span className="text-[11px] italic" style={{ color: "#5a4028" }}>No listings</span>
          )}
        </div>
        {item.count > 1 && item.totalValue != null && (
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-[11px] uppercase tracking-wider" style={{ color: "#5a4028" }}>Total (×{item.count})</span>
            <span className="text-[14px] font-bold" style={{ color: "#4ade80", fontFamily: "monospace" }}>
              ${item.totalValue.toFixed(2)}
            </span>
          </div>
        )}
      </div>

      {/* Volume */}
      {item.volume > 0 && (
        <div className="-mx-1 border-t pt-1.5" style={{ borderColor: "#1a1105" }}>
          <div className="flex justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "#5a4028" }}>Vol</div>
              <div className="text-[11px] font-semibold" style={{ color: "#8a6a30", fontFamily: "monospace" }}>
                {item.volume.toLocaleString()}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "#5a4028" }}>ID</div>
              <div className="text-[11px] font-semibold" style={{ color: "#8a6a30", fontFamily: "monospace" }}>
                {item.itemKey}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
