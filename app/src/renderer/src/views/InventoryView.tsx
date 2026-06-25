// InventoryView.tsx — shows the player's account inventory/stash with Steam pricing.
// Two collapsible sections (Inventory + Stash), each split into Materials / Equipment.
// Materials stacked by itemKey with ×N count; equipment listed individually with
// rarity badge + level. Sorted by total value descending.

import { useState, useEffect } from "react";
import {
  Loader2,
  Package,
  Archive,
  CircleDollarSign,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type { InventorySnapshot, InventoryItem } from "../../../shared/ipc-types.js";
import type { Translate } from "../../../shared/i18n/index.js";
import { useI18n } from "~/lib/i18n";
import { cn } from "~/lib/utils";

// ---------------------------------------------------------------------------
// Grade badge colors
// ---------------------------------------------------------------------------

const GRADE_COLORS: Record<number, string> = {
  5: "bg-amber-500/10 text-amber-400 ring-amber-500/30", // Legendary
  4: "bg-purple-500/10 text-purple-400 ring-purple-500/30", // Epic
  3: "bg-blue-500/10 text-blue-400 ring-blue-500/30",       // Rare
  2: "bg-green-500/10 text-green-400 ring-green-500/30",     // Uncommon
  1: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/30",       // Common
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

/** Materials: itemKey < 300k OR explicit slotId=0 / no grade. */
function isMaterial(it: InventoryItem): boolean {
  return it.itemKey < 300_000 || (it.slotId === 0 && it.gradeId == null);
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

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        <ItemSection
          icon={<Package className="size-4 text-brand-400" />}
          title={t("inventory.inventory")}
          items={data.inventory}
          t={t}
        />
        <ItemSection
          icon={<Archive className="size-4 text-amber-400" />}
          title={t("inventory.stash")}
          items={data.stash}
          t={t}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible section
// ---------------------------------------------------------------------------

function ItemSection({
  icon,
  title,
  items,
  t,
}: {
  icon: React.ReactNode;
  title: string;
  items: InventoryItem[] | null;
  t: Translate;
}) {
  const [open, setOpen] = useState(true);

  const materials = (items ?? []).filter(isMaterial);
  const equipment = (items ?? []).filter((it) => !isMaterial(it));

  const subtotal =
    [...materials, ...equipment]
      .filter((it) => it.totalValue != null)
      .reduce((s, it) => s + (it.totalValue ?? 0), 0);

  return (
    <div className="rounded-lg border border-surface-600 bg-surface-800/60">
      {/* Header */}
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-700/50"
      >
        {open ? (
          <ChevronDown className="size-3.5 text-zinc-500" />
        ) : (
          <ChevronRight className="size-3.5 text-zinc-500" />
        )}
        {icon}
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {title}
        </p>
        {items != null && (
          <span className="text-[10px] tabular-nums text-zinc-600">({items.length})</span>
        )}
        <div className="flex-1" />
        {subtotal > 0 && (
          <span className="text-xs font-bold tabular-nums text-emerald-400">
            ${subtotal.toFixed(2)}
          </span>
        )}
      </button>

      {/* Body */}
      {open && (
        <div className="px-3 pb-2.5">
          {items === null ? (
            <p className="flex items-center gap-1.5 py-1 text-xs text-amber-400">
              <AlertTriangle className="size-3" />
              {t("inventory.unavailable")}
            </p>
          ) : items.length === 0 ? (
            <p className="py-1 text-xs text-zinc-600">{t("inventory.empty")}</p>
          ) : (
            <div className="space-y-0.5">
              {/* Materials divider */}
              {materials.length > 0 && (
                <>
                  <Divider label={t("inventory.materials")} />
                  {materials
                    .sort((a, b) => (b.totalValue ?? 0) - (a.totalValue ?? 0))
                    .map((it, i) => (
                      <ItemRow key={`mat-${it.itemKey}-${i}`} item={it} />
                    ))}
                </>
              )}

              {/* Equipment divider */}
              {equipment.length > 0 && (
                <>
                  <Divider label={t("inventory.equipment")} />
                  {equipment
                    .sort((a, b) => (b.totalValue ?? 0) - (a.totalValue ?? 0))
                    .map((it, i) => (
                      <ItemRow key={`eq-${it.itemKey}-${i}`} item={it} />
                    ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single item row
// ---------------------------------------------------------------------------

function ItemRow({ item }: { item: InventoryItem }) {
  const gradeBadge = item.gradeId != null ? GRADE_COLORS[item.gradeId] : null;
  const gradeLabel = item.gradeId != null ? (GRADE_LABELS[item.gradeId] ?? "") : "";

  return (
    <div className="flex items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-surface-700/50">
      {/* Left: name + badges */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {/* Sprite placeholder (V1: real sprites via sync-data) */}
          <span className="shrink-0 text-sm leading-none opacity-60">
            {isMaterial(item) ? "💎" : item.slotId === 1 ? "🗡️" : item.slotId === 6 ? "🛡️" : "⚔️"}
          </span>

          <span className="truncate text-xs font-medium text-zinc-200">{item.name}</span>

          {/* Stack count for materials */}
          {item.count > 1 && (
            <span className="shrink-0 rounded bg-surface-700 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-400">
              ×{item.count}
            </span>
          )}

          {/* Rarity badge for equipment */}
          {gradeBadge && (
            <span
              className={cn(
                "shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold ring-1",
                gradeBadge,
              )}
            >
              {gradeLabel}
            </span>
          )}

          {/* Level for equipment */}
          {item.level != null && !isMaterial(item) && (
            <span className="text-[10px] tabular-nums text-zinc-500">Lv{item.level}</span>
          )}
        </div>
      </div>

      {/* Right: price */}
      <div className="flex shrink-0 items-center gap-3 text-right">
        {item.price != null ? (
          <>
            {/* Unit price (only when stacked) */}
            {item.count > 1 && (
              <span className="text-[10px] tabular-nums text-zinc-500">
                ${item.price.toFixed(2)}
              </span>
            )}
            {/* Total value */}
            <span className="min-w-16 text-xs font-bold tabular-nums text-emerald-400">
              ${item.totalValue!.toFixed(2)}
            </span>
          </>
        ) : (
          <span className="min-w-16 text-xs tabular-nums text-zinc-600" title="No active listings">
            —
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section divider
// ---------------------------------------------------------------------------

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="h-px flex-1 bg-surface-600" />
      <span className="text-[9px] font-semibold uppercase tracking-widest text-zinc-600">
        {label}
      </span>
      <div className="h-px flex-1 bg-surface-600" />
    </div>
  );
}
