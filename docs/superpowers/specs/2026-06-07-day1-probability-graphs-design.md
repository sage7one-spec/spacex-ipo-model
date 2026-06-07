# Day-1 Probability Graphs — Design

**Date:** 2026-06-07
**Status:** Approved (David)

## Problem

The live SpaceX IPO Day-1 model (`index.html` + `model.js`) has three issues David raised:

1. **No probability view of price.** He wants to see how likely any given price is to be
   *seen during the first day* — not just the closing distribution.
2. **The intraday fan is "blah."** Its y-axis auto-scales across the full fat-tailed range
   ($70–$372), which flattens the downward drift, and its shaded bands carry no legend or
   scale — they read as decorative rather than probabilistic.
3. **The `P(profit at close)` metric is misread.** "82%" is the *probability* of a green
   close, but it looks like a return. (The actual return, +26.7%, is already shown in the
   `Expected close` card — so this is a labeling problem, not a math bug.)

## Decision

Replace the existing intraday fan with two new, clearer charts, and fix the misleading label.
All work is confined to the **view layer in `index.html`**. `model.js` is unchanged — it
already returns `grid` (per-step prices for all paths), `lows`, and `highs`.

## Components

### A. Intraday Probability Heatmap (price × hour) — replaces the fan
- **Renderer:** custom `<canvas>`, no new library. (Chart.js has no native heatmap; a matrix
  plugin would be an unnecessary dependency.)
- **Axes:** x = 8 hourly steps (Open→Close); y = price, zoomed to ~$95–$265 with a note that
  tails extend beyond.
- **Color = probability:** brightness encodes the fraction of paths in each price/hour cell,
  globally normalized so hours are comparable. A labeled gradient legend shows actual %
  values (the requested probabilistic scale).
- **Overlays:** white median line; dashed $135 entry line.
- **Hover:** tooltip "≈ $X at +Nh — Y% of paths here."
- Re-renders live on every slider change and data refresh, like the other charts.

### B. Touch-Probability Ladder — new
- **Renderer:** Chart.js bar chart (price on x, probability on y).
- **Meaning:** for each price level, the chance the stock trades *through* it at some point
  during the day (derived from each path's `[low, high]` span).
- Green bars above $135 (in profit), red below.
- Hover: "$X — Y% chance it touches here."
- Sits directly below the heatmap in the same full-width section.

### C. Label fix
- `P(profit at close)` → **`Chance of a green close`** (subtitle unchanged: "close above $135").
- `Expected close` card left as-is (already shows the return).
- Section heading "Intraday Probability Fan — the 8-hour day" →
  "Intraday Probability — where the price trades, hour by hour."

## Layout

The fan's section becomes a single full-width card: **heatmap on top, touch-ladder below.**
The "Day-1 Outcomes" grid (close distribution + intraday range) and the Polymarket source-odds
curve are unchanged.

## Data flow

`render()` already calls `simulateDayOne(...)` and receives `{ closes, lows, highs, grid, ... }`.
- Heatmap consumes `grid` (bin each step's prices into a fixed price grid → per-cell fraction).
- Touch-ladder consumes `lows`/`highs` (for each price bin, fraction of paths whose span covers it).
Both are computed in new view-layer helpers and drawn in new `drawHeatmap()` / `drawTouch()`
functions, replacing `drawFan()`.

## Out of scope

- No changes to the Monte Carlo math, the blend logic, or the live-fetch code.
- No changes to the close-distribution, intraday-range, or Polymarket charts.

## Testing & verification

- Existing `test/` suite covers `model.js` and stays green (run to confirm — no model changes).
- Verify the page against the baked snapshot: both new charts render, respond to all sliders
  (position, entry, weight, shares, volatility), and survive a live data refresh; the relabeled
  metric reads correctly.
