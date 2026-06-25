# Item Hover Tooltip — Plan

> **For Hermes:** Modify `InventoryView.tsx` only. Add tooltip to `ItemCard`.

**Goal:** On mouse hover over an inventory item card, show a tooltip with the item name and key details (grade, level, quantity, price breakdown). The tooltip closes ~150ms after the cursor leaves.

**Tech:** Reuse existing `useHoverTooltip` hook (150ms close delay) + a simple absolutely-positioned tooltip within the card. No new dependencies.

---

## Tooltip Content

**Materials:**
```
Minor Ruby
×42  ·  $0.05 ea  ·  $2.10 total
Vol: 259 (24h)
```

**Equipment (tradable):**
```
Dimensional Sword
LEGENDARY  ·  Lv 80
$1.50
Vol: 38 (24h)
```

**Equipment (non-tradable):**
```
Elite Bow
RARE  ·  Lv 50
Not tradable
```

---

## Implementation

Single file change: `InventoryView.tsx`

1. Add `useHoverTooltip` import from `~/lib/use-hover-tooltip`
2. Add `GRADE_NAMES` map: `{5: "LEGENDARY", 4: "EPIC", 3: "RARE", 2: "UNCOMMON", 1: "COMMON"}`
3. Update `ItemCard` to use `useHoverTooltip` and render an `ItemTooltip` when open
4. Create `ItemTooltip` component rendering content based on material vs equipment
5. Position: absolute, bottom of card + 4px gap, centered, z-50, pointer-events-none

---

## States

| State | Tooltip |
|-------|---------|
| Hover material | Name, ×N, unit price, total, volume |
| Hover equipment (tradable) | Name, grade, level, price, volume |
| Hover equipment (non-tradable) | Name, grade, level, "Not tradable" |
| No hover | Nothing |
