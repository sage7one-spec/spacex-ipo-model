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

## Caveats

Both sources are **proxies** for the real stock: the Hyperliquid perp is synthetic with basis risk
(see the May 28 2026 oracle flash-crash), and the Polymarket markets are **timing-contaminated**
(they resolve "No" if no IPO by Dec 2027). Live data anchors the close **level**, not the intraday
**path** (the path is model-driven). The June 11 2026 date, $135 price, and share count are
user-supplied and unverified — confirm with Fidelity. **Not financial advice.**
