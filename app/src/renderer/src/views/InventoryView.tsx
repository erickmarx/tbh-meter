// InventoryView.tsx — visual icon grid of the player's inventory with Steam pricing.
// Materials and equipment unified from inventory + stash, separated only by category.
// Each card shows the item icon (emoji placeholder for MVP), price stamped bottom-right,
// quantity badge top-right (materials), and rarity+level bottom-left (equipment).
// Item names intentionally omitted — will appear elsewhere in a future release.

import { useState, useEffect } from "react";
import { Loader2, CircleDollarSign } from "lucide-react";
import type { InventorySnapshot, InventoryItem } from "../../../shared/ipc-types.js";
import type { Translate } from "../../../shared/i18n/index.js";
import { useI18n } from "~/lib/i18n";
import { cn } from "~/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRADE_COLORS: Record<number, string> = {
  5: "bg-amber-500/10 text-amber-400 ring-amber-500/30",
  4: "bg-purple-500/10 text-purple-400 ring-purple-500/30",
  3: "bg-blue-500/10 text-blue-400 ring-blue-500/30",
  2: "bg-green-500/10 text-green-400 ring-green-500/30",
  1: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/30",
};

const GRADE_LABELS: Record<number, string> = {
  5: "LEG",
  4: "EPIC",
  3: "RARE",
  2: "UNC",
  1: "COM",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMaterial(it: InventoryItem): boolean {
  return it.itemKey < 300_000 || (it.slotId === 0 && it.gradeId == null);
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function InventoryView() {
  const { t } = useI18n();
  const [data, setData] = useState<InventorySnapshot | null | "loading" | "error">("loading");

  useEffect(() => {
    setData("loading");
    window.meter
      .getInventory()
      .then((d) => setData(d ?? "error"))
      .catch(() => setData("error"));
  }, []);

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

  // Merge inventory + stash into one list
  const allItems = [...(data.inventory ?? []), ...(data.stash ?? [])];
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
          {freshness && (
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
              <CategoryGrid
                title={t("inventory.materials")}
                count={materials.length}
                items={materials}
              />
            )}
            {equipment.length > 0 && (
              <CategoryGrid
                title={t("inventory.equipment")}
                count={equipment.length}
                items={equipment}
              />
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
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))" }}>
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
  const gradeBadge = item.gradeId != null ? GRADE_COLORS[item.gradeId] : null;
  const gradeLabel = item.gradeId != null ? (GRADE_LABELS[item.gradeId] ?? "") : "";

  return (
    <div
      className={cn(
        "relative flex flex-col items-center rounded-lg border border-surface-600 bg-surface-800/60 p-1.5",
        "transition-colors hover:border-surface-500 hover:bg-surface-800",
      )}
    >
      {/* Quantity badge (top-right, materials only) */}
      {material && item.count > 1 && (
        <span className="absolute right-1 top-1 rounded bg-surface-700 px-1 text-[10px] font-bold tabular-nums text-zinc-300">
          ×{item.count}
        </span>
      )}

      {/* Icon (centered) */}
      <span className="my-1 text-2xl leading-none opacity-80">
        {spriteEmoji(item)}
      </span>

      {/* Bottom area: rarity+level (left) + price (right) */}
      <div className="mt-auto flex w-full items-end justify-between gap-1">
        {/* Left: rarity badge + level (equipment only) */}
        <div className="flex flex-col items-start gap-0.5">
          {!material && gradeBadge && (
            <span
              className={cn(
                "rounded px-1 py-px text-[8px] font-semibold leading-tight ring-1",
                gradeBadge,
              )}
            >
              {gradeLabel}
            </span>
          )}
          {!material && item.level != null && (
            <span className="text-[9px] tabular-nums leading-tight text-zinc-500">
              Lv{item.level}
            </span>
          )}
        </div>

        {/* Right: price stamp */}
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
    </div>
  );
}
