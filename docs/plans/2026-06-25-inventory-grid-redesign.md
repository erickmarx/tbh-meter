# Inventory Grid View — UI Redesign Plan

> **For Hermes:** Modify `InventoryView.tsx` only. Backend unchanged.

**Goal:** Replace the list-based inventory view with a visual **icon grid** (matrix), where each item is a card with its sprite/icon, name, and a price badge stamped on the bottom-right corner. Unify Inventory + Stash into a single grid, separated only by category (Materials / Equipment).

**Status:** Only `InventoryView.tsx` changes. IPC endpoint, steam-prices, inventory-source, i18n — all unchanged.

---

## Visual Design

```
┌──────────────────────────────────────────────────────────┐
│ TBH  [Runs] [Tracker] [Planner] [Inventário] [⚙]        │
├──────────────────────────────────────────────────────────┤
│                                                          │
│   Inventário                          💰 Valor Total     │
│                                       $ 14.82            │
│   12 de 15 itens precificados                             │
│   🟢 Steam ao vivo  ·  Preços atualizados há 3 min       │
│                                                          │
│  ── Materiais (8) ──────────────────────────────────     │
│                                                          │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐          │
│  │ ×42  │ │ ×15  │ │  ×8  │ │  ×3  │ │  ×3  │          │
│  │      │ │      │ │      │ │      │ │      │          │
│  │  💎  │ │  💎  │ │  💎  │ │  💎  │ │  💎  │          │
│  │      │ │      │ │      │ │      │ │      │          │
│  │      │ │      │ │      │ │      │ │      │          │
│  │$0.05 │ │$0.03 │ │$0.04 │ │$0.03 │ │$0.07 │          │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘          │
│                                                          │
│  ── Equipamentos (5) ───────────────────────────────     │
│                                                          │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐          │
│  │      │ │      │ │      │ │      │ │      │          │
│  │  🗡️  │ │  🛡️  │ │  🏹  │ │  ⚔️  │ │  📿  │          │
│  │      │ │      │ │      │ │      │ │      │          │
│  │[LEG] │ │[EPIC]│ │[RARE]│ │[RARE]│ │[LEG] │          │
│  │ Lv80 │ │ Lv60 │ │ Lv50 │ │ Lv45 │ │ Lv75 │          │
│  │$1.50 │ │$2.10 │ │$0.89 │ │$0.75 │ │$3.20 │          │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Card anatomy

Cada card é um quadrado de ~80×80px (materiais) ou ~88×96px (equipamentos):

**Material:**
```
┌──────────┐
│  ×42     │  ← quantity badge (top-right)
│          │
│    💎    │  ← sprite/icon (centered, 32px)
│          │
│          │
│    $0.05 │  ← price (bottom-right, stamped)
└──────────┘
```

**Equipamento:**
```
┌──────────┐
│          │
│    🗡️    │  ← sprite/icon (centered, 32px)
│          │
│ [LEG]    │  ← rarity badge (bottom-left)
│ Lv80     │  ← level (bottom-left)
│    $1.50 │  ← price (bottom-right, stamped)
└──────────┘
```

### Grid layout

- CSS Grid: `grid-template-columns: repeat(auto-fill, minmax(96px, 1fr))`
- Gap: 8px entre cards
- Responsivo: mais colunas em janelas largas
- Scroll vertical na página toda (não por seção)
- Cada seção (Materiais / Equipamentos) tem header + grid próprio

### Price badge

- Preço estampado no canto **inferior direito** do card
- Cor: `text-emerald-400` (mesmo tom do valor total)
- Tamanho: `text-[11px] font-bold tabular-nums`
- Fundo sutil: `bg-emerald-500/10 rounded` com padding 1px 4px
- Para itens sem preço: mostrar `—` em `text-zinc-600`

### Name truncation

- Máximo 2 linhas no card (line-clamp-2)
- `text-[10px]` para caber nomes longos como "Dimensional Sword"

### Rarity badge (equipment)

- Badge colorido inline com o nome: `[LEG]` amber, `[EPIC]` purple, etc.
- Na linha abaixo do nome, junto com o nível: `Lv80`

### Quantity badge (materials)

- Canto **superior direito** do card
- `×42` em `text-[11px] font-bold`
- Fundo: `bg-surface-700 rounded px-1.5`

---

## Component Structure

```
InventoryView
├── Header (title, grand total, status line, freshness)
├── CategorySection "Materiais"
│   ├── Section header ("Materiais (8)")
│   └── Grid
│       └── ItemCard[] (material variant)
└── CategorySection "Equipamentos"
    ├── Section header ("Equipamentos (5)")
    └── Grid
        └── ItemCard[] (equipment variant)
```

### ItemCard variants

**Material card:**
- Top-right: quantity badge (×N, only if count > 1)
- Center: icon
- Bottom-left: name (1-2 lines)
- Bottom-right: price

**Equipment card:**
- Center: icon
- Bottom-left: name + rarity badge + level
- Bottom-right: price

---

## Implementation

### File to modify

Only one file: `app/src/renderer/src/views/InventoryView.tsx`

### Changes needed

1. **Remove** Inventory/Stash separation — unify all items into one list
2. **Split** unified items into materials vs equipment (`isMaterial()`)
3. **Replace** `<ItemSection>` (collapsible list) with `<CategoryGrid>` (non-collapsible grid)
4. **Replace** `<ItemRow>` with `<ItemCard>` 
5. **Add** grid CSS, card styling, price stamp positioning
6. **Remove** `ChevronDown`, `ChevronRight` imports
7. **Add** `Grid3X3` or keep simple (no new icon imports needed)
8. **Update** grand total to include both inventory and stash combined (already done in IPC, but View previously showed them separately — now they're merged)

### i18n

No changes needed — existing keys already cover the new design.

### States (unchanged)

- Loading: spinner
- No data: empty state message
- Cards with null price: show `—`

---

## Verification

```bash
cd app && pnpm check && pnpm test
```

Manual: open app → Inventory tab → confirm:
- Grid layout renders cards correctly
- Materials show quantity badge (top-right) and price (bottom-right)
- Equipment show rarity badge + level + price
- Grid is responsive (more columns on wider window)
- Grand total in header reflects combined inventory+stash
