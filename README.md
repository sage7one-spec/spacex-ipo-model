# SpaceX IPO — Day-1 Live Model

Live, browser-based Monte-Carlo model of SpaceX's Day-1 intraday price for a $135 pre-IPO
allocation. It pulls fresh data on **every page load** (no server, no API keys):

- **Hyperliquid** `xyz:SPCX` synthetic pre-IPO perp — live per-share mark price.
- **Polymarket** "closing market cap above $X" markets — crowd-sourced close distribution.

The Day-1 close is a **blend** (weight slider): Hyperliquid sets the center level, Polymarket sets
the spread. 10,000 paths run a Brownian bridge from a historically-grounded opening print to the
blended close, with per-interval extremes sampled from the bridge's closed-form extreme-value law
so touch/stop/fill events are detected continuously, not just on the hour. Add-ons:
intraday-volatility default derived from SPCX's real realized vol × an IPO-day multiplier (2×), a
Hyperliquid-vs-Polymarket **agreement/confidence** gauge, and a SPCX **funding-rate sentiment** chip.

If either API is unreachable the page falls back to a baked-in snapshot and flags it ("last-known
data") — a shared link never shows a blank or broken page.

**Live:** https://sage7one-spec.github.io/spacex-ipo-model/

## Three strategies — all reported in net absolute dollars on one capital base

All scenarios are benchmarked to the **same capital base** (the position-size input, default
$100,000) and scored as a **signed net dollar change** (e.g. +$22,000 / −$5,000) — not as
percentages or running balances. All three strategies are scored on the **same 10,000 simulated
paths** (common random numbers), so scorecard differences are strategy, not sampling noise; the
mean row shows the Monte Carlo standard error. A "Three-strategy scorecard" in the UI shows A/B/C
side by side.

**Case A — Day-1 flip (the Execution Plan).** Buy the $135 pre-IPO allocation (~741 shares on
$100,000), sell on Day 1 using the laddered plan below. Net $ reflects the gain or loss on that
~$100k deployment.

**Case B — Bottom-Feeder (separate $100,000 CASH play).** A limit BUY that fills only if SPCX
trades *down* to a target price (default $135) at some point on Day 1; an OCO bracket (profit
target / stop-loss) exits the same day. If the stock never dips to the limit, nothing fills →
exactly **$0 net, capital fully preserved** (the No-Execution safety state). If the open prints
*below* the limit, the buy fills at the open (price improvement), and the bracket stop never
exits above the actual fill. On the baked snapshot
the fill probability is ~24%, and of those fills the majority hit the stop rather than the target
(the dip tends to keep falling) — so the unconditional strategy EV is roughly break-even to
slightly negative. The reported net-$ distribution **includes the $0 no-fill days**; that is the
full unconditional picture. The discipline is in the exit — the OCO bracket enforces it
automatically.

**Case C — Post-IPO hold (20-day probabilistic fan).** Hold the $135 allocation to a chosen exit
day across a 20-day fan of paths, replacing the former static Day-16 comparison. Fidelity's flip
window is 15 **calendar** days (not trading sessions): from the Fri Jun 12 IPO it ends over the
Jun 27–28 weekend, so the first penalty-free sale is **Mon Jun 29** — trading Day 10 on the chart's
NYSE calendar, and the default exit day. Each simulated path
starts at its Day-1 close (already HL/Poly-blended) and evolves forward stochastically. On the
baked snapshot roughly 20% of paths are underwater at the Day-1 close, rising to roughly 25% by Day
20.

## Develop

- `npm test` — unit tests (Node 25 built-in runner) for the pure model in `model.js`.
- `python3 -m http.server 8765` then open http://localhost:8765/ — run locally (ES modules need HTTP, not `file://`).
- Regenerate the fallback snapshot from fresh fixtures: re-run the capture + `snapshot.js` generator in
  `docs/superpowers/plans/2026-06-06-spacex-ipo-live-model.md` (Tasks 0 & 8).

## Layout

- `index.html` — UI, Chart.js, live fetch + fallback, rendering; includes the Case B bottom-feeder
  section, the Case C 20-day fan chart, and the three-strategy scorecard.
- `model.js` — pure, tested logic: parsing, seeded RNG, cap sampler, realized vol, disagreement,
  blend, simulation. New exports: `simulateBottomFeed`, `bottomFeedTicket`, `simulatePostIPO`,
  `postIpoBands`, `MEGA_IPO_POSTIPO_CURVE`, `netDollars`, `fmtNet`. Removed: `simulateDay16`,
  `buildDay16Policy`.
- `snapshot.js` — `BAKED_SNAPSHOT` fallback data.
- `vendor/chart.umd.min.js` — Chart.js 4.4.1 bundled locally (no CDN dependency on IPO morning).
- `test/` — unit tests + captured API fixtures.

## Blending weights

**Day-1 close center (shared by all strategies):**

```
center = w · HL_mark + (1 − w) · Poly_median_per_share
```

where `w` is the HL/Poly weight slider. Hyperliquid sets the center level; Polymarket sets the
close-cap spread.

**20-day path evolution (Case C):** each path starts at its Day-1 close (already blended above) and
advances one trading day at a time as:

```
Δlog = (−0.5σ² + σ·Z)
     + driftWeight · log(curve[d] / curve[d−1])
     + anchorStrength · (d/20) · (log T − log S)
```

where:
- `σ` = daily volatility (slider, same vol as Day-1 intraday).
- `Z` ~ N(0,1) — fresh Brownian increment.
- `driftWeight` (default **0** = martingale) scales the baked `MEGA_IPO_POSTIPO_CURVE` historical
  shape; raise it to pull the fan toward the historical mega-IPO pattern.
- `anchorStrength` (default **0.3**) ramps a soft pull toward a per-path Polymarket-implied terminal
  price `T`; `S` is the current step price. `T` is **rank-coupled** to the path's own Day-1 close
  (same survival-curve uniform), so a path that closed at its 95th percentile anchors to the
  95th-percentile terminal — an independent draw would manufacture cross-sectional mean reversion
  and artificially shrink the 20-day fan.
- `d` runs 1 → 20 so the anchor strengthens linearly over the holding period.

Net effect: Hyperliquid governs the level and early path, the historical curve adds optional shape,
Polymarket governs the terminal spread. Both `driftWeight` and `anchorStrength` are user-adjustable
sliders.

## Execution Plan (Day-1, Case A)

The **Execution Plan** section turns the simulated price grid into a scaled sell plan for the $135
allocation, scored against all 10,000 paths:

- **Reference-anchored, not basis-anchored.** SPCX is expected to open far above $135, so
  profit-taking rungs hang off a **reference opening price** (the model's expected open, or an
  editable input you set to the actual first print on IPO day) — not the cost basis. Each scenario
  sells a **core at the open** (market) to lock the in-the-money gain, ladders the rest **above**
  the reference, and protects with a **stop clamped to `[ $135 basis , reference ]`** (never below
  your basis, never above the market).
- **Three postures** — Protect First / Balanced / Ride the Upside — span the core-at-open size
  (more core = more locked at the open; less core = more held for upside behind the stop). A
  protection-aggressiveness slider reshapes them and everything re-scores live.
- **Fidelity tickets** — a core market order at the open, OCO brackets (sell-limit-up /
  sell-stop-down) per tranche, an MOC/LOC residual, and manual stop-escalation checkpoints with ET
  times (Active Trader Pro).
- **Outcome stats** vs. sell-at-open and hold-to-close baselines, all expressed as net dollars on
  $100,000.

**Honest read:** in this model the single highest-expected-value Day-1 move is to sell into the
open; the laddered scenarios trade a small expected haircut for upside participation plus a defined
floor. The model fills stops *at* the stop price, so real gap-through risk on the "hold more"
scenarios is understated. All scoring lives in pure, unit-tested functions in `model.js`
(`evaluatePolicy`, `buildScenario`, `ticketsFromPolicy`, …).

## Caveats

Both sources are **proxies** for the real stock: the Hyperliquid perp is synthetic with basis risk
(see the May 28 2026 oracle flash-crash), and the Polymarket markets are **timing-contaminated**
(they resolve "No" if no IPO by Dec 2027) — the model divides the curve by its low-threshold
plateau (≈ the crowd's P(IPO)) to recover the conditional distribution. Live data anchors the
close **level**, not the intraday **path** (the path is model-driven). The June 11 2026 date, $135 price, and share count are
user-supplied and unverified — confirm with Fidelity.

Case B's net-$ distribution includes the $0 no-fill days (it is the unconditional strategy EV, not
the conditional-on-fill EV). Case C's fan is probabilistic — individual paths should not be read as
forecasts. **Not financial advice.**
