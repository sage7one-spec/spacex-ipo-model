# Design: Bottom-Feeder (Case B), 20-Day Post-IPO Engine, and Unified $100k Reporting

**Date:** 2026-06-09
**Repo:** `spacex-ipo-model` (git@github.com:sage7one-spec/spacex-ipo-model.git)
**Status:** Approved (design phase). Next: implementation plan.

## Context

The repo is a browser-based, no-server Monte-Carlo model of SpaceX's Day-1 intraday price for
a $135 pre-IPO allocation. Architecture: pure, unit-tested functions in `model.js`; a thin
`index.html` renderer (Chart.js); live Hyperliquid (`xyz:SPCX` perp) + Polymarket (close-cap
markets) fetches with a baked-snapshot fallback (`snapshot.js`). This design adds a second
execution strategy, replaces the static Day-16 logic with a 20-day probabilistic engine, and
unifies all reporting around a fixed $100,000 cost basis rendered in net absolute dollars.

This design preserves the existing pattern exactly: all new math is pure and tested in
`model.js`; `index.html` gains render sections that consume it. No framework, no build step.

### Grounding numbers (baked 2026-06-06 snapshot, $135 entry, w=0.5, vol slider=6)

- **P(intraday low ≤ $135) = 24.2%** — the Case B fill probability. (~76% of days, no fill.)
- **Conditional on a fill, holding to the close: median −$6,835, mean −$10,579.** Dips to $135
  are autocorrelated with weak closes, so bottom-feeding only pays with a disciplined *exit*.
  This is why Case B's bracket (target/stop) is the core of the strategy, not the entry.
- **P(price < $135): 20.0% at Day-1 close → 22.9% (Day-12) → 23.9% (Day-16) → 24.6% (Day-20).**
  The forced-hold (Fidelity allocation) downside: ~1-in-4 underwater at the flip-rule expiry,
  median ~$164. Tails widen with horizon and with realized vol (this snapshot's daily σ ≈ 3.1%
  is low).

## Cases (all benchmarked to $100,000 initial purchasing power)

- **Case A** — Pre-IPO allocation bought at $135, sold Day 1 (existing execution plan).
- **Case B** — Open-market limit buy at ≤ $135 on Day 1, bracket exit Day 1 (NEW; Phase 1).
- **Case C** — Pre-IPO allocation bought at $135, held to Day 20 (NEW engine; Phase 2).

$100,000 = **740.74 shares @ $135**. Default position input changes from $150,000 → $100,000.

## Phase 3 foundation — reporting uniformity (applied across A/B/C)

New pure helpers in `model.js`:

- `netDollars(proceeds, capital = 100000)` → `proceeds - capital`.
- `fmtNet(dollars)` → signed absolute-dollar string, e.g. `+$25,000`, `-$12,300`, `$0`.

**Rule:** every financial outcome's headline metric is net absolute dollar change. Raw
percentages and total-balance figures are banned as the *primary* metric; a percentage may
appear only as a secondary/parenthetical annotation. The $100,000 basis is fixed for scoring;
the position input defaults to and benchmarks $100,000.

## Phase 1 — Case B "Bottom-Feeder"

New pure fn `simulateBottomFeed(paths, cfg)`.

- **Resolution:** Case B runs `simulateDayOne` at finer resolution (default `steps = 26`,
  ≈15-min bars) so intraday limit fills and bracket crossings are detected near the true 24.2%
  touch rate (the 8-step Day-1 fan grid understates it). The main Day-1 fan keeps 8 steps.
- **Entry:** limit buy at `limitPx` (default $135, editable). A path fills at `limitPx` on the
  first step whose price ≤ `limitPx`; the full $100,000 deploys (740.74 sh at the limit).
- **Exit — Fidelity bracket (OCO):** on fill, sell-limit at `limitPx·(1 + targetPct)` and
  sell-stop at `limitPx·(1 − stopPct)`, evaluated each subsequent step with **target checked
  before stop** within a step (matches `evaluatePolicy`'s tie-break). Unsold residual sells at
  the close. `targetPct` and `stopPct` are editable inputs.
- **No-Execution safety state:** if no step ≤ `limitPx`, the path records **exactly $0.00 net
  and preserves $100,000** — explicit and unit-tested.
- **Output:** `{ pFill, pNoFill, net: {mean, median, p5, p95}, mix: {targetPct, stopPct,
  closePct, noFillPct}, nets: number[] }` where `nets` is per-path net $ on $100k (0 for
  no-fill). A separate ticket builder renders the Fidelity ATP order set (limit buy + OCO
  bracket; TIF Day).

## Phase 2 — 20-Day Post-IPO engine (replaces Day-16)

**Delete** `simulateDay16` and `buildDay16Policy` (and their tests). Replace with:

`simulatePostIPO(cfg)` where `cfg = { closes, dailySigma, rng, days = 20, driftCurve,
driftWeight = 0, polyTerminal: { thresh, above, shares }, anchorStrength = 0.3 }`.

For each path, start `s = closes[p]` (each Day-1 close is already an HL/Poly blend). Sample a
terminal per-share level `T_p` from the Polymarket close-cap curve once per path. For day
`d = 1..days`, update log-price by:

```
Δlog s = -0.5·σ² + σ·Z                          (GBM diffusion, σ = dailySigma)
       + driftWeight · historicalDrift[d]        (optional baked mega-IPO shape)
       + anchorStrength · (d/days) · (log T_p − log s)   (Polymarket soft terminal anchor)
```

- **Historical drift:** baked `MEGA_IPO_POSTIPO_CURVE` — a normalized 20-day per-day log-drift
  series from comparable large tech/space listings (early fade then partial recovery shape).
  Off by default (`driftWeight = 0`, martingale); slider-exposed.
- **Soft anchor:** reversion strength ramps linearly with `d/days` so Hyperliquid governs the
  early path/level and Polymarket governs the terminal spread; `anchorStrength` slider-exposed,
  default 0.3.

`postIpoBands(grid)` → per-day `{ p5, p25, median, p75, p95 }` plus per-day `pBelow135`.

**Fan chart output:** 20-day percentile envelope, median path, a **hardcoded prominent $135
horizontal baseline**, per-day P(< $135), and Case C net-$ at a selectable exit day (1–20),
where net = `740.74 · price[exitDay] − 100000`.

## Phase 3 — Three-Strategy Scorecard (UI)

New `index.html` section rendering A / B / C side-by-side, every figure in **net $**:

| | Case A (allocation, Day-1 exit) | Case B (bottom-feed, Day-1) | Case C (allocation, Day-20 hold) |
|---|---|---|---|
| Mean net $ | ✓ | ✓ | ✓ |
| Median net $ | ✓ | ✓ | ✓ |
| p5 / p95 net $ | ✓ | ✓ | ✓ |
| P(loss) | ✓ | ✓ | ✓ |
| Signature stat | P(sub-basis sale) | P(fill) / P(no-fill) | P(underwater @ exit day) |

## UI section changes (`index.html`)

1. Day-1 fan / heatmap / execution plan (Case A): normalize to $100k, convert headline
   displays to net $. Keep the $135 baseline.
2. NEW Case B "Bottom-Feeder": inputs (limit $135, target%, stop%); outputs (P(fill), net-$
   distribution + small histogram, outcome mix, Fidelity bracket ticket).
3. REPLACE the Day-16 comparison with the 20-day fan (Case C): percentile bands, median path,
   $135 baseline, drift-weight slider, anchor-strength slider, per-day P(<135), net-$ at a
   selectable exit day.
4. NEW Three-Strategy Scorecard.

## Blending-weights assumptions (deliverable: spec + README writeup)

- **Day-1 close center:** `center = w·HL_mark + (1−w)·Poly_median_per_share` (existing `w`
  slider). Hyperliquid sets the center level; Polymarket sets the close-cap spread.
- **20-day path:** start at each path's Day-1 close (already blended). Daily evolution blends
  three terms: GBM diffusion (`dailySigma`, from realized vol), an optional baked historical
  drift shape (`driftWeight`, default 0), and a Polymarket terminal soft-anchor whose pull
  ramps to Day 20 (`anchorStrength`, default 0.3). Net effect: HL dominates level and early
  path; the historical curve adds optional shape; Polymarket governs the terminal distribution.

## Testing

- `simulateBottomFeed`: fill detection, bracket target-before-stop, **$0/no-fill invariant**,
  net-$ aggregation, mix sums to 1.
- `simulatePostIPO` / `postIpoBands`: band ordering (p5 ≤ p25 ≤ median ≤ p75 ≤ p95), variance
  growth with horizon, terminal-anchor convergence toward the Polymarket spread as
  `anchorStrength` rises, martingale behavior at `driftWeight=0`/`anchorStrength=0`.
- `netDollars` / `fmtNet`: sign, rounding, `$0` formatting.
- Remove Day-16 tests.

## Out of scope

- No change to the live-fetch / fallback mechanism or Polymarket/Hyperliquid parsing.
- No new external data sources beyond the existing two plus the baked historical curve.
- Not financial advice; date/$135/share-count remain user-supplied and unverified.
