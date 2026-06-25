// inventory-source.ts — read account inventory/stash from live agent or raw records.
// Primary: sendAgentCommand("inventory") — live data from game memory.
// Fallback: read the most recent raw/<id>.json (inventory captured at run close).
// Resolves item names from items-min.json.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import itemsMinData from "../shared/data/items-min.json" with { type: "json" };

import { sendAgentCommand } from "./agent-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single item as read from the agent or raw record (before price aggregation). */
interface RawInventoryItem {
  itemKey: number;
  uniqueId: string;
  name: string;
  slotId: number | null;
  gradeId: number | null;
  level: number | null;
}

/** Inventory data from one source. */
export interface InventoryData {
  inventory: RawInventoryItem[] | null; // null = unreadable (err envelope)
  stash: RawInventoryItem[] | null;
  runes: { key: number; level: number }[] | null;
  /** "live" (agent) or "raw" (fallback). */
  source: "live" | "raw";
  /** Raw record id (only for "raw" source). */
  sourceRunId: string | null;
}

// ---------------------------------------------------------------------------
// Item name resolution
// ---------------------------------------------------------------------------

const itemNames = itemsMinData as Record<string, string>;

function resolveName(itemKey: number | null | undefined): string {
  if (itemKey == null) return "Unknown";
  return itemNames[String(itemKey)] ?? `Unknown (key: ${itemKey})`;
}

// ---------------------------------------------------------------------------
// Agent path (live data from game memory)
// ---------------------------------------------------------------------------

/** Agent result shape for op_inventory. */
interface AgentInventoryResult {
  error?: string;
  psd?: string;
  runes?: { key: number; level: number }[] | null;
  inventory?: RawSnapshotItem[] | null;
  stash?: RawSnapshotItem[] | null;
}

interface RawSnapshotItem {
  itemKey?: number | null;
  uniqueId?: string;
  slotId?: number | null;
  gradeId?: number | null;
  level?: number | null;
}

async function tryAgent(outputDir: string): Promise<InventoryData | null> {
  const result = await sendAgentCommand(outputDir, "inventory", 30_000);
  if (!result || typeof result !== "object") return null;

  const r = result as AgentInventoryResult;
  if (r.error) return null;

  const mapItems = (raw: RawSnapshotItem[] | null | undefined): RawInventoryItem[] | null => {
    if (!raw) return null;
    return raw.map((it) => ({
      itemKey: it.itemKey ?? 0,
      uniqueId: it.uniqueId ?? "0",
      name: resolveName(it.itemKey),
      slotId: it.slotId ?? null,
      gradeId: it.gradeId ?? null,
      level: it.level ?? null,
    }));
  };

  return {
    inventory: mapItems(r.inventory),
    stash: mapItems(r.stash),
    runes: r.runes ?? null,
    source: "live",
    sourceRunId: null,
  };
}

// ---------------------------------------------------------------------------
// Raw record fallback (inventory from last run close)
// ---------------------------------------------------------------------------

function tryRawRecord(outputDir: string): InventoryData | null {
  const rawDir = join(outputDir, "raw");
  let files: string[];
  try {
    files = readdirSync(rawDir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  // Most recent by filename (which is the ts in ms)
  files.sort((a, b) => b.localeCompare(a));
  const latest = files[0];

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(rawDir, latest), "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  const unwrapItems = (field: unknown): RawInventoryItem[] | null => {
    if (!field || typeof field !== "object") return null;
    const f = field as { ok?: boolean; value?: unknown };
    if (!f.ok || !Array.isArray(f.value)) return null;
    return (f.value as RawSnapshotItem[]).map((it) => ({
      itemKey: it.itemKey ?? 0,
      uniqueId: it.uniqueId ?? "0",
      name: resolveName(it.itemKey),
      slotId: it.slotId ?? null,
      gradeId: it.gradeId ?? null,
      level: it.level ?? null,
    }));
  };

  const unwrapRunes = (field: unknown): { key: number; level: number }[] | null => {
    if (!field || typeof field !== "object") return null;
    const f = field as { ok?: boolean; value?: unknown };
    if (!f.ok || !Array.isArray(f.value)) return null;
    return f.value as { key: number; level: number }[];
  };

  return {
    inventory: unwrapItems(raw.inventory),
    stash: unwrapItems(raw.stash),
    runes: unwrapRunes(raw.runes),
    source: "raw",
    sourceRunId: latest,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the player's inventory/stash, preferring live data from the agent
 * when available, falling back to the most recent raw record.
 * Returns null when no data source is available.
 */
export async function getInventoryData(outputDir: string): Promise<InventoryData | null> {
  // Try live agent first
  const live = await tryAgent(outputDir);
  if (live) return live;

  // Fall back to raw record
  return tryRawRecord(outputDir);
}
