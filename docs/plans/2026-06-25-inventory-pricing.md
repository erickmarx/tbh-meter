# Inventory Pricing — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Show the player's account inventory/stash items with Steam Community Market pricing in a new "Inventory" tab in the tbh-meter app. The user sees exactly what their account is worth on the Steam Market.

**Architecture:** Primary data source is the reader's `agent_windows.py` via a new `op_inventory` command — the app sends a command, the reader reads `PlayerSaveData` live from game memory and replies with items. Fallback: read from the most recent `raw/<id>.json` when the reader/agent isn't running. Item names resolved from `items-min.json`. Steam prices fetched via `priceoverview` API (cached locally). New `InventoryView` tab renders items grouped by inventory/stash with sprites, names, badges, and prices.

**Tech Stack:** Python (reader: new `op_inventory`), TypeScript (Electron main: agent-client + steam-prices + IPC), React (renderer: InventoryView). Steam Community Market API (HTTP), local JSON cache.

---

## User-Facing Design

### Layout

```
┌──────────────────────────────────────────────────────┐
│ TBH  [Runs] [Tracker] [Planner] [Inventário] [⚙]    │
├──────────────────────────────────────────────────────┤
│                                                      │
│   Inventário                       💰 Valor Total    │
│                                    $ 14.82           │
│   12 de 15 itens precificados                        │
│   Preços atualizados há 3 min  ·  🟢 Steam ao vivo   │
│                                                      │
│  ┌─ 📦 Inventário (23)  ───────────────── $8.92 ─┐   │
│  │                                                │   │
│  │  ── Materiais ──                               │   │
│  │  [💎] Minor Ruby           ×42   $0.05  $2.10  │   │
│  │  [💎] Obsidian Shard       ×15   $0.03  $0.45  │   │
│  │  [💎] Sapphire             ×8    $0.04  $0.32  │   │
│  │  [💎] Pearl                ×3    $0.03  $0.09  │   │
│  │  ── Equipamentos ──                            │   │
│  │  [🗡️] Dimensional Sword   [LEG] Lv80   $1.50   │   │
│  │  [🏹] Elite Bow           [RARE] Lv50  $0.89   │   │
│  │  [🛡️] Ancient Armor       [EPIC] Lv60  $2.10   │   │
│  │  [⚔️] Bastard Sword       [RARE] Lv45  $0.75   │   │
│  │  ... (scroll)                                   │   │
│  └────────────────────────────────────────────────┘   │
│                                                      │
│  ┌─ 🗄️ Baú (8)  ──────────────────── $5.90 ──────┐   │
│  │                                                │   │
│  │  ── Materiais ──                               │   │
│  │  [💎] Void Crystal          ×3    $0.07  $0.21  │   │
│  │  [💎] Chaos Diamond         ×2    $0.09  $0.18  │   │
│  │  ── Equipamentos ──                            │   │
│  │  [📿] Abyss Amulet         [LEG] Lv75   $3.20   │   │
│  │  [🛡️] Dragon Shield        [EPIC] Lv60  $2.31   │   │
│  └────────────────────────────────────────────────┘   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Elementos visuais

**Header da tab:**
- Título "Inventário" à esquerda
- **Valor total** em destaque (emerald, fonte grande, `$14.82`) à direita
- Linha de status: "X de Y itens precificados"
- Timestamp de preço: "Preços atualizados há 3 min" com indicador de frescor:
  - 🟢 Steam ao vivo (< 1h)
  - 🟡 Cache (1h–24h)
  - 🔴 Stale (> 24h)

**Seções colapsáveis** (Inventário / Baú):
- Cada seção é um card com header colapsável (clica expande/colapsa)
- Header mostra: ícone + nome + contagem + subtotal
- Dentro da seção: **divisor visual** entre Materiais e Equipamentos
- Ordenação: mais valiosos primeiro (por `totalValue` decrescente)

**Linha de material** (stackável):
```
[💎 sprite 24px]  Minor Ruby        ×42   $0.05  $2.10
                   nome              qtd   unit   total
```

**Linha de equipamento** (individual):
```
[🗡️ sprite 24px]  Dimensional Sword  [LEG] Lv80  $1.50
                   nome               rarity lvl  price
```

**Badges de raridade** (cores Steam-like):
| Grade | Cor | Badge |
|-------|-----|-------|
| Legendary | amber-400 | `LEG` |
| Epic | purple-400 | `EPIC` |
| Rare | blue-400 | `RARE` |
| Uncommon | green-400 | `UNC` |
| Common | zinc-400 | `COM` |

**Sprites de itens** (V1 — não no MVP):
- Caminho: `sprites/Item_<itemKey>.png`
- 24×24 px na linha do item
- MVP: placeholder `[💎]` para materiais, `[🗡️]`/`[🛡️]` etc por slot para equipamentos
- V1: sprites reais via `scripts/sync-data.mjs` (adicionar `data/sprites/items/` ao sync)

### Estados

| Estado | UI |
|--------|----|
| Carregando | Spinner central + "Carregando inventário..." |
| Jogo fechado + sem raw | "Nenhum dado — abra o jogo ou complete uma run" |
| Inventory err (unreadable) | ⚠️ "Inventário indisponível" |
| Item sem preço Steam | Mostra "—" na coluna de preço (raro com mercado aberto) |
| Steam API offline | Preços do cache (stale) + indicador 🔴 |
| Cache vazio + API offline | "—" para todos os itens + aviso |

---

## Data Flow

```
┌─────────────────────────────────────────────────┐
│ PRIMARY: Reader on-demand (agent_cmd)            │
│                                                  │
│  InventoryView (tab open)                        │
│      │                                           │
│      ▼                                           │
│  IPC: getInventory()                             │
│      │                                           │
│      ▼                                           │
│  inventory-source.ts                             │
│      │                                           │
│      ├─ Try: agent_cmd {"op":"inventory"}        │
│      │   └─ agent_windows.py::op_inventory()     │
│      │       └─ build.read_account_snapshot()    │
│      │           └─ PlayerSaveData (live memory) │
│      │                                           │
│      └─ Fallback: raw/<id>.json mais recente     │
│                                                  │
│      ▼                                           │
│  steam-prices.ts (cache + API)                   │
│      ▼                                           │
│  InventorySnapshot → InventoryView               │
└─────────────────────────────────────────────────┘
```

---

## Implementation Tasks

### Task 0: Add `op_inventory` command to agent_windows.py

**Objective:** New agent command that reads inventory/stash from live PlayerSaveData and returns raw items.

**Files:**
- Modify: `reader/agent_windows.py`
- Modify: `reader/tests/test_raw_record.py` (add agent command test)

**Step 1: Add import and command handler**

In `agent_windows.py`, add the import (near the other `from game import`):

```python
from game import build
```

Add to `OPS` dict:

```python
"inventory": op_inventory,
```

Add the handler function (before `OPS`):

```python
def op_inventory(_):
    """Read account inventory + stash from live PlayerSaveData, 1 round-trip.
    Returns RAW items (itemKey/uniqueId/slotId/gradeId/level/mods) — the caller resolves names.
    Uses the SAME read_account_snapshot() the meter calls on every run close."""
    psd = save.pick_live_psd(READER, INST.get("PlayerSaveData", []))
    if not psd:
        return {"error": "live PlayerSaveData not found"}
    try:
        # Item catalog is heavy (6k items) and not needed for raw data.
        # Pass an empty dict — _item_view still returns itemKey/gradeId/slotId/level.
        runes, inventory, stash = build.read_account_snapshot(READER, psd, {})
        return {
            "psd": hex(psd),
            "runes": runes,
            "inventory": inventory,
            "stash": stash,
        }
    except Exception as e:
        return {"error": str(e)}
```

**Step 2: Verify with existing tests**

```bash
cd reader && python -m pytest tests/ -x -q
```
Expected: All existing tests pass. `op_inventory` reuses battle-tested `read_account_snapshot()`.

**Step 3: Commit**

```bash
git add reader/agent_windows.py
git commit -m "feat(reader): add op_inventory agent command for live inventory read"
```

---

### Task 1: Create agent-client module (app → reader)

**Objective:** App-side module that sends commands to `agent_windows.py` and reads responses.

**Files:**
- Create: `app/src/main/agent-client.ts`
- Test: `app/src/main/__tests__/agent-client.test.ts`

**Design:** The agent watches `output/agent_cmd.json` and replies to `output/agent_resp.json`. The app writes a command with incrementing `id`, polls `agent_resp.json` until the matching `id` appears, returns the result.

```typescript
// agent-client.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface AgentCommand {
  id: number;
  op: string;
}

interface AgentResponse {
  id: number;
  op: string;
  ms: number;
  result: unknown;
}

const AGENT_POLL_MS = 300;
const AGENT_TIMEOUT_MS = 30_000;

let _id = 0;
function nextId(): number { return ++_id; }

/**
 * Send a command to the running agent_windows.py and wait for the response.
 * Resolves null when the agent isn't running (cmd/resp files don't exist).
 */
export async function sendAgentCommand(op: string, timeoutMs = AGENT_TIMEOUT_MS): Promise<unknown | null> {
  const readerDir = join(process.resourcesPath ?? "", "..", "reader");
  const outDir = join(readerDir, "output");
  const cmdPath = join(outDir, "agent_cmd.json");
  const respPath = join(outDir, "agent_resp.json");

  // Agent not running → no output dir
  if (!existsSync(cmdPath)) return null;

  const id = nextId();
  const cmd: AgentCommand = { id, op };

  try { writeFileSync(cmdPath, JSON.stringify(cmd), "utf-8"); }
  catch { return null; }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(respPath, "utf-8");
      const resp = JSON.parse(raw) as AgentResponse;
      if (resp.id === id && resp.op === op) return resp.result;
    } catch { /* file doesn't exist yet or partial write */ }
    await new Promise(r => setTimeout(r, AGENT_POLL_MS));
  }

  return null; // timeout
}
```

**Step 1: Write test (mocked filesystem)**

```typescript
// __tests__/agent-client.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendAgentCommand } from "../agent-client.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Test by writing real files to a temp dir and mocking process.resourcesPath
const tmp = join(tmpdir(), `agent-test-${Date.now()}`);

vi.stubGlobal("process", {
  ...process,
  resourcesPath: tmp,
});

beforeEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "..", "reader", "output"), { recursive: true });
});

describe("sendAgentCommand", () => {
  it("returns null when agent not running", async () => {
    // No cmd file → agent not running
    const r = await sendAgentCommand("inventory");
    expect(r).toBeNull();
  });

  it("sends command and reads response", async () => {
    const cmdPath = join(tmp, "..", "reader", "output", "agent_cmd.json");
    const respPath = join(tmp, "..", "reader", "output", "agent_resp.json");

    writeFileSync(cmdPath, "{}"); // agent is running (file exists)

    // Simulate the agent: write response after a short delay
    setTimeout(() => {
      const resp = { id: 1, op: "inventory", ms: 42, result: { ok: true } };
      writeFileSync(respPath, JSON.stringify(resp));
    }, 500);

    const r = await sendAgentCommand("inventory");
    expect(r).toEqual({ ok: true });
  });
});
```

**Step 3: Commit**

```bash
git add app/src/main/agent-client.ts app/src/main/__tests__/agent-client.test.ts
git commit -m "feat(app): add agent-client for reader command/response protocol"
```

---

### Task 2: Create Steam price fetcher service

**Objective:** Fetch item prices from Steam Community Market, cached to `~/tbh-meter/prices.json`.

**Files:**
- Create: `app/src/main/steam-prices.ts`
- Test: `app/src/main/__tests__/steam-prices.test.ts`

(Same implementation as previously planned — TDD cycle, cache with 1h/24h TTL, rate-limited batch fetch, parse `median_price`.)

**Commit:**

```bash
git add app/src/main/steam-prices.ts app/src/main/__tests__/steam-prices.test.ts
git commit -m "feat(app): add Steam price fetcher with local cache"
```

---

### Task 3: Create inventory source (agent → fallback → prices)

**Objective:** Try agent_cmd first, fall back to raw record, resolve names, fetch prices.

**Files:**
- Create: `app/src/main/inventory-source.ts`
- Test: `app/src/main/__tests__/inventory-source.test.ts`

**Architecture:**

```typescript
// inventory-source.ts
// getInventory(outputDir) → tries agent_cmd("inventory") → on success, return live data
// → on failure/null (agent not running), read latest raw/<id>.json
// → resolve names from items-min.json
// → return { inventory, stash, runes, source: "live" | "raw" }
```

The module imports `agent-client.ts` for the primary path and reads raw files for fallback. It does NOT import steam-prices — pricing is done in the IPC handler (Task 4).

**Step 1: Write test**
**Step 2: Run test (fail)**
**Step 3: Write implementation**
**Step 4: Run test (pass)**
**Step 5: Commit**

```bash
git add app/src/main/inventory-source.ts app/src/main/__tests__/inventory-source.test.ts
git commit -m "feat(app): add inventory source with agent+fallback data paths"
```

---

### Task 4: Add IPC endpoint + wire pricing

**Objective:** `getInventory()` IPC handler that calls inventory-source, fetches Steam prices, aggregates by itemKey, returns `InventorySnapshot`.

**Files:**
- Modify: `app/src/shared/ipc-types.ts` (add `InventoryItem`, `InventorySnapshot`, `getInventory()`)
- Modify: `app/src/main/ipc.ts` (wire handler)
- Modify: `app/src/preload/index.ts` (add bridge)

**Types to add:**

```typescript
export interface InventoryItem {
  itemKey: number;
  uniqueId: string;
  name: string;
  slotId: number | null;
  gradeId: number | null;
  level: number | null;
  count: number;               // >1 for stacked materials
  price: number | null;        // USD unit price
  volume: number;
  totalValue: number | null;   // count × price
}

export interface InventorySnapshot {
  inventory: InventoryItem[] | null;
  stash: InventoryItem[] | null;
  runes: { key: number; level: number }[] | null;
  source: "live" | "raw";      // where the data came from
  sourceRunId: string | null;
  grandTotal: number;
  pricedCount: number;
  unpricedCount: number;
  priceSource: "steam" | "cache" | "mixed";
  /** Unix ms when prices were last fetched from Steam (youngest). */
  pricesFetchedAt: number | null;
}
```

**Handler logic (in ipc.ts):**

```typescript
ipcMain.handle("meter:get-inventory", async () => {
  const dir = resolveOutputDir();
  if (!dir) return null;

  const data = await getInventoryData(dir); // from inventory-source
  if (!data.source) return null; // no data at all

  // Collect unique itemKeys for price lookup
  const allItems = [...(data.inventory ?? []), ...(data.stash ?? [])];
  const uniqueItems = new Map<number, string>();
  for (const it of allItems) {
    if (it.itemKey > 0 && !uniqueItems.has(it.itemKey)) {
      uniqueItems.set(it.itemKey, it.name);
    }
  }

  // Fetch prices (cached or fresh)
  const prices = await getItemPrices(
    [...uniqueItems.entries()].map(([itemKey, name]) => ({ itemKey, name }))
  );

  // Aggregate materials by itemKey, equipment stays individual
  const aggregate = (items: typeof allItems): InventoryItem[] => {
    const groups = new Map<number, { name: string; items: typeof allItems }>();
    for (const it of items) {
      const g = groups.get(it.itemKey) ?? { name: it.name, items: [] };
      g.items.push(it);
      groups.set(it.itemKey, g);
    }
    return [...groups.entries()].map(([itemKey, g]) => {
      const p = prices.get(itemKey);
      const count = g.items.length;
      const price = p?.price ?? null;
      return {
        itemKey, uniqueId: g.items[0].uniqueId, name: g.name,
        slotId: g.items[0].slotId, gradeId: g.items[0].gradeId,
        level: g.items[0].level, count, price,
        volume: p?.volume ?? 0,
        totalValue: price != null ? +(price * count).toFixed(2) : null,
      };
    });
  };

  const invItems = data.inventory ? aggregate(data.inventory) : null;
  const stashItems = data.stash ? aggregate(data.stash) : null;

  const allPriced = [...(invItems ?? []), ...(stashItems ?? [])];
  const withPrice = allPriced.filter(it => it.price != null);
  const grandTotal = +withPrice.reduce((s, it) => s + (it.totalValue ?? 0), 0).toFixed(2);

  const sources = [...prices.values()].map(p => p.source);
  const fetchedAts = [...prices.values()].map(p => p.fetchedAt).filter(Boolean);

  return {
    inventory: invItems,
    stash: stashItems,
    runes: data.runes,
    source: data.source,
    sourceRunId: data.sourceRunId,
    grandTotal,
    pricedCount: withPrice.length,
    unpricedCount: allPriced.length - withPrice.length,
    priceSource: sources.every(s => s === "steam") ? "steam"
               : sources.every(s => s === "cache") ? "cache" : "mixed",
    pricesFetchedAt: fetchedAts.length > 0 ? Math.min(...fetchedAts) : null,
  };
});
```

**Step: Type-check + commit**

```bash
cd app && pnpm check
git add app/src/shared/ipc-types.ts app/src/main/ipc.ts app/src/preload/index.ts
git commit -m "feat(app): add getInventory IPC endpoint with Steam pricing"
```

---

### Task 5: Create InventoryView component

**Objective:** React component rendering inventory/stash items with pricing, collapsible sections, rarity badges, material/equipment dividers.

**Files:**
- Create: `app/src/renderer/src/views/InventoryView.tsx`

**Implementation details:**

- Two collapsible `<section>` cards (Inventory + Stash), default expanded
- Each section: header with icon + name + count + subtotal, body with scroll
- Body divided: "Materiais" divider → material rows, "Equipamentos" divider → equipment rows
- `isMaterial = itemKey < 300_000 || (slotId === 0 && gradeId == null)`
- Material rows: stacked (×N), show unit price + total
- Equipment rows: individual, show rarity badge + level + price
- Sprite: `sprites/Item_<itemKey>.png` (V1), MVP usa placeholder por slot
- Sort: by `totalValue` descending, then alphabetically
- Timestamp: "Preços atualizados há X min" via `pricesFetchedAt`
- Frescor: 🟢 <1h, 🟡 1–24h, 🔴 >24h

**Commit:**

```bash
git add app/src/renderer/src/views/InventoryView.tsx
git commit -m "feat(app): add InventoryView with collapsible sections and pricing"
```

---

### Task 6: Add "Inventory" tab + i18n

**Objective:** Wire InventoryView into navigation with pt-BR translations.

**Files:**
- Modify: `app/src/renderer/src/components/Header.tsx` — add `"inventory"` to `ListTab`
- Modify: `app/src/renderer/src/ListApp.tsx` — add `<InventoryView />` case
- Modify: `app/src/shared/i18n/en-us.ts` — add inventory keys
- Modify: `app/src/shared/i18n/pt-br.ts` — add inventory keys

**i18n keys (en-us):**

```typescript
"header.tabInventory": "Inventory",
"inventory.title": "Inventory",
"inventory.loading": "Loading inventory…",
"inventory.noData": "No inventory data",
"inventory.noDataHint": "Open the game or complete a run to capture your inventory.",
"inventory.totalValue": "Total Value",
"inventory.pricedCount": "{priced} of {total} items priced",
"inventory.priceLive": "Steam live",
"inventory.priceCached": "from cache",
"inventory.priceStale": "prices stale",
"inventory.updatedAgo": "Prices updated {time} ago",
"inventory.updatedMin": "{n} min",
"inventory.updatedHour": "{n} hour",
"inventory.updatedHours": "{n} hours",
"inventory.inventory": "Inventory",
"inventory.stash": "Stash",
"inventory.materials": "Materials",
"inventory.equipment": "Equipment",
"inventory.empty": "No items",
"inventory.unavailable": "Inventory data unavailable for this run.",
"inventory.sourceLive": "Live data",
"inventory.sourceRaw": "From last run",
```

**i18n keys (pt-br):**

```typescript
"header.tabInventory": "Inventário",
"inventory.title": "Inventário",
"inventory.loading": "Carregando inventário…",
"inventory.noData": "Sem dados de inventário",
"inventory.noDataHint": "Abra o jogo ou complete uma run para capturar seu inventário.",
"inventory.totalValue": "Valor Total",
"inventory.pricedCount": "{priced} de {total} itens precificados",
"inventory.priceLive": "Steam ao vivo",
"inventory.priceCached": "do cache",
"inventory.priceStale": "preços desatualizados",
"inventory.updatedAgo": "Preços atualizados há {time}",
"inventory.updatedMin": "{n} min",
"inventory.updatedHour": "{n} hora",
"inventory.updatedHours": "{n} horas",
"inventory.inventory": "Inventário",
"inventory.stash": "Baú",
"inventory.materials": "Materiais",
"inventory.equipment": "Equipamentos",
"inventory.empty": "Nenhum item",
"inventory.unavailable": "Dados de inventário indisponíveis nesta run.",
"inventory.sourceLive": "Dados ao vivo",
"inventory.sourceRaw": "Da última run",
```

**Step: Verify + commit**

```bash
cd app && pnpm check && pnpm test
git add app/src/renderer/src/components/Header.tsx \
        app/src/renderer/src/ListApp.tsx \
        app/src/shared/i18n/en-us.ts \
        app/src/shared/i18n/pt-br.ts
git commit -m "feat(app): add Inventory tab with i18n (en-us + pt-br)"
```

---

## Verification

```bash
# App side
cd app && pnpm check && pnpm test

# Reader side
cd reader && ruff check . && python -m pytest

# Manual: open game → click Inventory tab → confirm live data
# Manual: close game → click Inventory tab → confirm fallback to raw record
# Manual: confirm Steam prices appear for materials AND equipment
```

---

## Out of Scope (V1 / future)

- **Sprites de itens**: MVP usa placeholder por slot (`[💎]` materiais, `[🗡️]` espadas, etc). V1: adicionar `data/sprites/items/Item_<key>.png` ao sync-data e renderizar sprites reais na linha
- **Filtro/search**: por nome ou tipo (materiais/equipamentos)
- **Histórico de preço**: gráfico ou variação 24h
- **Ordenação customizável**: além de valor decrescente
