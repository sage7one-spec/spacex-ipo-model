# SpaceX IPO — Day-1 Live Model

Live, browser-based Monte-Carlo model of SpaceX's Day-1 intraday price for a $135 pre-IPO
allocation. It pulls fresh data on **every page load** (no server, no API keys):

- **Hyperliquid** `xyz:SPCX` synthetic pre-IPO perp — live per-share mark price.
- **Polymarket** "closing market cap above $X" markets — crowd-sourced close distribution.

The Day-1 close is a **blend** (weight slider): Hyperliquid sets the center, Polymarket sets the
spread. 10,000 paths run a Brownian bridge from a historically-grounded opening print to the blended
close. Add-ons: intraday-volatility default derived from SPCX's real realized vol, a Hyperliquid-vs-
Polymarket **agreement/confidence** gauge, and a SPCX **funding-rate sentiment** chip.

If either API is unreachable the page falls back to a baked-in snapshot and flags it ("last-known
data") — a shared link never shows a blank or broken page.

**Live:** https://sage7one-spec.github.io/spacex-ipo-model/

## Develop

- `npm test` — unit tests (Node 25 built-in runner) for the pure model in `model.js`.
- `python3 -m http.server 8765` then open http://localhost:8765/ — run locally (ES modules need HTTP, not `file://`).
- Regenerate the fallback snapshot from fresh fixtures: re-run the capture + `snapshot.js` generator in
  `docs/superpowers/plans/2026-06-06-spacex-ipo-live-model.md` (Tasks 0 & 8).

## Layout

- `index.html` — UI, Chart.js, live fetch + fallback, rendering.
- `model.js` — pure, tested logic: parsing, seeded RNG, cap sampler, realized vol, disagreement, blend, simulation.
- `snapshot.js` — `BAKED_SNAPSHOT` fallback data.
- `test/` — unit tests + captured API fixtures.

## Execution Plan (Day-1)

The **Execution Plan** section turns the simulated price grid into a scaled sell plan for the $135
allocation, scored against all 10,000 paths:

- **Reference-anchored, not basis-anchored.** SPCX is expected to open far above $135, so profit-taking
  rungs hang off a **reference opening price** (the model's expected open, or an editable input you set
  to the actual first print on IPO day) — not the cost basis. Each scenario sells a **core at the open**
  (market) to lock the in-the-money gain, ladders the rest **above** the reference, and protects with a
  **stop clamped to `[ $135 basis , reference ]`** (never below your basis, never above the market).
- **Three postures** — Protect First / Balanced / Ride the Upside — span the core-at-open size
  (more core = more locked at the open; less core = more held for upside behind the stop). A
  protection-aggressiveness slider reshapes them and everything re-scores live.
- **Fidelity tickets** — a core market order at the open, OCO brackets (sell-limit-up / sell-stop-down)
  per tranche, an MOC/LOC residual, and manual stop-escalation checkpoints with ET times (Active Trader Pro).
- **Outcome stats** vs. sell-at-open and hold-to-close baselines, plus a quantitative **Day-1 (flip)
  vs Day-16 (clean)** comparison showing the dollar cost of the 15-day flip rule.

**Honest read:** in this model the single highest-expected-value Day-1 move is to sell into the open;
the laddered scenarios trade a small expected haircut for upside participation plus a defined floor.
The model fills stops *at* the stop price, so real gap-through risk on the "hold more" scenarios is
understated. All scoring lives in pure, unit-tested functions in `model.js`
(`evaluatePolicy`, `buildScenario`, `ticketsFromPolicy`, `simulateDay16`, …).

## Caveats

Both sources are **proxies** for the real stock: the Hyperliquid perp is synthetic with basis risk
(see the May 28 2026 oracle flash-crash), and the Polymarket markets are **timing-contaminated**
(they resolve "No" if no IPO by Dec 2027). Live data anchors the close **level**, not the intraday
**path** (the path is model-driven). The June 11 2026 date, $135 price, and share count are
user-supplied and unverified — confirm with Fidelity. **Not financial advice.**
