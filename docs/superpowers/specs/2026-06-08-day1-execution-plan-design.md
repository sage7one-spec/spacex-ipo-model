# Day-1 Execution Plan — Design Spec

**Date:** 2026-06-08
**Status:** Approved (brainstorming) — pending spec review
**Builds on:** the existing live Monte-Carlo model (`model.js` / `index.html`), which already
produces a 10,000-path × 8-step intraday price grid for SpaceX's Day-1 session.

---

## 1. Problem & objective

The user holds a **$150,000 pre-IPO allocation at $135/share → 1,111 shares** (basis $150,000;
$15 residual). They want a Day-1 execution strategy that:

1. **Maximizes expected proceeds** by scaling out across the session.
2. **Minimizes the risk of selling below the $135 basis.** Operationally (user's words): never
   take a *large* loss — selling at/just below $135 is preferable to riding it down; but do **not**
   get shaken out by a transient early dip that the model says usually recovers. Selling early is
   fine when that is the likeliest-best outcome.
3. Allows **multiple tranches and multiple scenarios**.
4. Is **expressed entirely in Fidelity's actual order types**.
5. **Liquidates fully before the 4:00pm ET close** (flat by EOD), with explicit fallback orders.

### Hard constraint discovered & accepted: the Fidelity flip rule
Selling SpaceX IPO shares within the **first 15 calendar days** flags the account as a "flipper"
and blocks future Fidelity new-issue access (6 months / 1 year / permanent, by SSN). The shares are
**not** frozen — Day-1 selling is executable; the cost is *access*, not dollars. First clean sell
day is day 16. (Source: Fidelity SpaceX IPO page + IPO FAQ, retrieved 2026-06-08.)

**Decision:** build the **Day-1 plan as primary**, plus a **quantitative Day-16 comparison** so the
user can see the implied dollar value of keeping IPO access before deciding.

This is **not financial advice**. The June 11 2026 date, $135 price, and share count remain
user-supplied and unverified.

---

## 2. Architecture

All scoring logic is added to `model.js` as **pure, unit-tested functions** (matching repo
convention); all rendering is added to `index.html` as a new "Execution Plan" section. No new
dependencies, no server.

```
simulateDayOne(cfg) ──► { grid[9][N], closes[N], lows[N], highs[N], entry, center }   (existing)
        │
        ├─► evaluatePolicy(paths, policy) ──► per-path fills → aggregate outcome stats   (NEW)
        ├─► conditionalRecovery(grid, entry) ──► P(close>entry | price<entry at hour k)  (NEW)
        ├─► buildScenario(name, riskLevel, ctx) ──► a `policy` object                     (NEW)
        ├─► ticketsFromPolicy(policy, shares) ──► Fidelity order-ticket rows              (NEW)
        └─► simulateDay16(cfg) + evaluatePolicy ──► Day-16 outcome stats for comparison   (NEW)
```

### Data contract: `policy`
```
policy = {
  tranches: [ { fracShares, limitPx, stopSchedule } , ... ],  // limitPx and stop both relative to entry
  closeOut: 'MOC',                  // residual sells at close price
  // stopSchedule: array of {fromStepFrac, stopPx} — stop level active from that point in the session;
  //               null/absent before first entry = "no stop (room to recover)"
}
```

### Data contract: `evaluatePolicy` output
```
{
  perPath: undefined,            // not retained (memory); only aggregates kept
  Eproceeds, medianProceeds, p5, p95,
  pNetLoss,                      // P(total proceeds < $150,000 basis)
  pSubBasisSale,                 // P(>=1 share sold < $135)
  eSharesSubBasis,               // expected # shares sold under $135
  avgSalePx,
  mix: { upsidePct, stopPct, closePct }   // where shares were sold, on average
}
```

---

## 3. Scoring engine — `evaluatePolicy(paths, policy)`

For each path (using the 9 open→close step prices in `grid[k][p]`):

1. Walk steps `k = 0..8` chronologically. Maintain `sharesLeft`.
2. **Limit fills:** a tranche with `limitPx = L` fills its shares at the first step where
   `price[k] >= L`. (8-step granularity approximates intraday highs; documented limitation.)
3. **Stop fills:** the active stop level at step `k` is the latest `stopSchedule` entry whose
   `fromStepFrac <= k/8`. If `price[k] <= stop`, remaining-in-tranche shares fill at `stop`
   (model a small slippage knob, default 0).
4. **Tie-break within a step:** if a step both crosses a limit up and a stop down (whipsaw), apply
   the **limit first** for un-triggered upside tranches, then evaluate stops — documented choice,
   conservative toward the user's "capture upside" intent but flagged.
5. **Close-out:** any `sharesLeft` at `k = 8` sell at `grid[8][p]` (= MOC/LOC).
6. Record proceeds = Σ(shares × fill px), P&L vs $150,000, and any fills `< 135`.

Aggregate per §2 contract. **Baselines** computed the same way: `sellAllAtOpen` (all shares at
`grid[0]`) and `holdToClose` (all shares at `grid[8]`).

---

## 4. Conditional "don't shake me out" stat — `conditionalRecovery(grid, entry)`

For each early step `k` (k = 1, 2, 3), compute over all paths:
`P(grid[8][p] > entry  |  grid[k][p] < entry)`.

This is the model-grounded justification for running **no tight stop in the morning**. The tab
surfaces it as a sentence, e.g. *"When SPCX dips below $135 in the first hour, it still closes green
84% of the time — which is why this plan gives the position room early and only tightens into the
close."* (Number computed live, not hard-coded.)

---

## 5. The three scenarios — `buildScenario(name, riskLevel, ctx)`

All scenarios are **time-phased** and all force a flat close. `riskLevel` (0–100 slider, "max
acceptable P(sub-$135 sale)") reshapes rung spacing and stop tightness. Default rung sets:

| Scenario | Upside limit rungs (× entry) | Tranche split | Stop schedule (relative to entry) |
|---|---|---|---|
| **Protect First** | +3% / +6% / +10% | 40 / 30 / 20 (10% residual→MOC) | none until ~25% of session, then −4%, ratcheting to −1% by power hour |
| **Balanced** ⭐ | +4% / +8% / +12% / +18% | 25 / 25 / 25 / 15 (10% residual→MOC) | none until ~40% of session (room to recover), then −6% trailing, tightening to −2% into close |
| **Ride the Upside** | +10% / +20% / +30% | 25 / 25 / 25 (25% residual→MOC) | wide −12% until final ~20% of session, then snap to −3% |

Scenario parameters are **validated by scoring** — each is run through `evaluatePolicy` and must
beat a naïve fixed-$135 stop on E[proceeds] at equal-or-lower P(sub-$135 sale). The slider lets the
user trade the frontier; the engine re-scores on every change.

---

## 6. Fidelity ticket mapping — `ticketsFromPolicy(policy, shares)`

Each upside tranche is paired with its protective stop as a **One-Cancels-the-Other (OCO)** bracket
in **Active Trader Pro** (sell-limit-up OCO sell-stop-down; whichever fills cancels the other).
Output rows: *tranche · shares · order type · limit px · stop px · TIF (Day)*.

**Execution realities baked into the rendered timeline (not hidden in caveats):**
- **At the open an IPO has no prior price** → stop / trailing-stop orders may be rejected until a
  print exists. Morning protection = **limit sells live at the open**; the stop leg is **added once
  SPCX is trading** (first checkpoint).
- **Fidelity stops don't self-escalate on a clock.** "Escalation" is rendered as **2–3 explicit
  manual checkpoints** with wall-clock times, e.g. *"~12:30pm: cancel stop, re-enter at $X"* and
  *"~3:45pm: any residual → Market (or confirm MOC was accepted)."*
- **Residual close-out** = **MOC/LOC**, labeled "confirm your account/security accepts on-close
  orders" with a **manual 3:45pm market-sell fallback** if not.
- Slippage note on stops/market during fast moves; SpaceX Day-1 liquidity makes 1,111 shares small,
  but halts/circuit-breakers can still gap fills.

---

## 7. Day-16 quantitative comparison — `simulateDay16(cfg)`

Avoids the flip penalty. Extends the Day-1 close distribution forward to day 16:

1. Start each path from its Day-1 **close** (`grid[8][p]`).
2. Evolve **~11 trading days** (16 calendar days ≈ 11 trading days) of GBM:
   `S_{t+1} = S_t · exp((−0.5σ²)Δ + σ·√Δ·Z)`, daily `σ` from the realized-vol input (drift ≈ 0,
   stated assumption), with an explicit **overnight-gap** component so multi-day risk is represented.
3. Apply a simple **3-day scale-out** (days 16–18) limit ladder + trailing stop, scored by the same
   `evaluatePolicy` machinery (reused on the day-16 path set).
4. **Headline metric:** `E[proceeds Day-16] − E[proceeds Day-1 Balanced]` = the implied **dollar
   cost (or benefit) of keeping IPO access**, shown beside a plain note that Day-16 carries
   multi-day/overnight risk the single-session Day-1 plan does not.

Drift = 0 is a deliberate, stated neutral assumption (the model anchors level, not a directional
view); a small drift slider may be added if trivial, otherwise documented as fixed.

---

## 8. UI — new "Execution Plan" section in `index.html`

Placed below the existing probability charts:
- **Scenario selector** (3 buttons) + **risk slider**.
- **Outcome-stats card:** E[proceeds], median, P5/P95, P(net loss), P(any sub-$135 sale),
  E[shares sold < $135] — each vs. the sell-at-open and hold-to-close baselines.
- **Conditional-recovery sentence** (§4).
- **Ladder/ticket table** (§6) with a copy affordance.
- **Intraday checkpoint timeline** (wall-clock actions, §6).
- **Comparison chart:** the 3 Day-1 scenarios + the Day-16 outcome on one expected-proceeds-vs-risk
  view, with the access-cost figure called out.

Re-renders whenever the simulation re-runs (data refresh / re-roll / input change), reusing the
existing `state`/render plumbing.

---

## 9. Testing

`test/` gains unit tests for each new pure function:
- `evaluatePolicy`: hand-built tiny path sets with known fills (limit-only, stop-only, whipsaw
  tie-break, forced close-out, all-below-basis).
- `conditionalRecovery`: synthetic grid with known conditional.
- `buildScenario`: shape/fraction sums to 1.0; rungs monotonic.
- `ticketsFromPolicy`: row count, OCO pairing, share allocation sums to position.
- `simulateDay16`: determinism under seeded RNG; close-distribution sanity (mean ≈ Day-1 close).

Run via existing `npm test` (Node built-in runner).

---

## 10. Out of scope (YAGNI)

- No live Fidelity API / order placement — tickets are **for the user to enter manually**.
- No tax-lot / wash-sale logic.
- No full policy optimizer (Approach B) — scenarios are parameterized presets validated by scoring.
- No extended-hours modeling beyond the on-close fallback.
- No change to the existing Day-1 price model or its charts.

---

## 11. Caveats carried into the UI

Not financial advice. Date/$135/share-count unverified (no S-1 in data). Flip penalty restated.
8-step fill granularity approximates intraday highs/lows. IPO open-delay & no-prior-price stop
nuance. Slippage on stops/market in fast moves. Model anchors *level*, not *path* — cannot predict a
specific halt, circuit-breaker, or news shock. A 1,111-share position can move thousands of dollars
in minutes.
