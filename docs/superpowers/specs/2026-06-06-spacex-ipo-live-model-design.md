# SpaceX IPO Live Model v2 — Design

**Date:** 2026-06-06
**Author:** David Larson (with Claude)
**Status:** Approved for planning
**Supersedes:** Frozen v1 (`Dave's AI Vault/Stocks and investments/SpaceX-IPO-Model/2026-06-04_SpaceX-IPO-Day1-Intraday-Model_v1.html`) — static, Polymarket snapshot baked in.

## 1. Goal

Turn the frozen, static SpaceX IPO Day-1 intraday model into a **live, shareable** tool:

1. **Live-on-open** — pulls fresh Hyperliquid (per-share price) and Polymarket (close-cap distribution) data every time the page loads, so it is useful in the run-up to the **June 11 2026** IPO.
2. **Shareable** — a real public URL that David can send to others to view.

Both requirements are why the page must be **hosted**, not opened from `file://` (a local file cannot be shared and browsers block its cross-origin API fetches via `Origin: null`).

## 2. Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Hosting | **GitHub Pages**, new **public** repo `spacex-ipo-model` under `sage7one-spec` → `https://sage7one-spec.github.io/spacex-ipo-model/` |
| Close-anchor logic | **Blend**: Hyperliquid mark = center of the Day-1 close distribution; Polymarket CDF = spread/shape; a weight slider shifts the center between the two sources |
| Refresh behavior | **On open + manual "Refresh data" button** (no auto-ticking timer) |
| Prediction add-ons | (1) realized vol from real SPCX candles, (2) model-disagreement gauge, (3) funding-rate sentiment + crash caution |
| Out of scope (YAGNI) | float-scarcity premium, convergence weighting, other venues (Bitget/secondary), any server/proxy |

## 3. Architecture

Single self-contained `index.html` (preserves v1's one-file simplicity), Chart.js via CDN. **All live data fetched client-side in the visitor's browser** — no server, no proxy, no API keys. Deploy once; the page stays current because data is pulled fresh on each visit. The deployed file embeds a **baked-in snapshot** of verified values used only as a fallback.

```
Browser opens index.html
        │
        ├─ fetchLive()  ──► Hyperliquid /info (metaAndAssetCtxs + candleSnapshot, dex=xyz)
        │                └► Polymarket gamma /events?slug=spacex-ipo-closing-market-cap-above
        │
        ├─ on success → parse → state.live = {hl, poly, vol, funding, ts}
        ├─ on failure → state.live = BAKED_SNAPSHOT  (amber "last-known" badge)
        │
        └─ runModel(state) → blended close distribution → Monte Carlo → charts + metrics
```

## 4. Data layer (`fetchLive`) — endpoints verified 2026-06-06, both CORS `*`

### Hyperliquid (per-share price, candles, funding)
- **Endpoint:** `POST https://api.hyperliquid.xyz/info`, `Content-Type: application/json`.
- **Asset:** SpaceX trades as **`xyz:SPCX`** — a HIP-3 builder perp under the `xyz` (Trade.xyz/XYZ) dex.
- **Price + funding:** body `{"type":"metaAndAssetCtxs","dex":"xyz"}` → match `universe[i].name == "xyz:SPCX"`, read `assetCtxs[i].markPx`, `oraclePx`, `prevDayPx`, `funding`. (Today: mark 164.68, oracle 165.07, prevDay 163.78, funding ≈ −1.03e-6.)
- **Candles (for realized vol):** body `{"type":"candleSnapshot","req":{"coin":"xyz:SPCX","interval":"1h","startTime":<ms>}}` → array of `{t,o,h,l,c,v,n}` (verified: ~472 hourly candles returned).

### Polymarket (close-cap distribution)
- **Endpoint:** `GET https://gamma-api.polymarket.com/events?slug=spacex-ipo-closing-market-cap-above`.
- Returns one event with **16 bucket markets**, each "SpaceX IPO closing market cap above $X?" with `outcomePrices` (`[Yes, No]`). Yes-price = cumulative **P(cap > $X)**.
- Parse each `question` for the threshold `$X` (handle `$1T`, `$1.4T`, etc.), pair with its Yes-price, sort ascending → a cumulative survival curve over market cap.
- **Robustness:** enforce monotonic non-increasing P as threshold rises (clamp thin-market noise); drop unparseable rows.

### Cap → per-share conversion
`pricePerShare = marketCap / sharesOutstanding`, where `sharesOutstanding` is an existing user slider (default ~12.96B, tunable). Used to express the Polymarket distribution in $/share so it can blend with Hyperliquid.

## 5. Model changes

### 5.1 Blended close distribution
- Build the **Polymarket-implied $/share distribution** from the cumulative cap curve (differentiate the survival curve into bucket probabilities, convert each bucket midpoint to $/share via share count).
- **Center (median):** `blendCenter = w·HL_mark + (1−w)·Poly_median`, where `w` ∈ [0,1] from the **"Hyperliquid ⇄ Polymarket" weight slider** (default 0.5).
- **Shape/spread:** take the Polymarket distribution's *shape* (skew, tail widths) and re-center it on `blendCenter`. This gives a live point estimate with a crowd-sourced, fat-tailed spread.
- Day-1 close samples draw from this blended distribution. Open print and intraday path stay as v1 (historical mega-IPO open→close base rates + Brownian bridge over hourly steps).

### 5.2 Realized volatility from SPCX candles (add-on #1)
- From the hourly candle close series, compute log-returns → annualized/sessionized realized vol → set the **default** of the existing intraday-vol slider (user can still override). Show "vol: X% (from SPCX 20d realized)".

### 5.3 Model-disagreement gauge (add-on #2)
- Compute `HL_impliedPerShare` (= mark) vs `Poly_medianPerShare`. Display the spread (absolute $ and %). Map to a 3-tier confidence readout: tight (<5%) = high confidence, 5–15% = moderate, >15% = low. (Today ≈ $165 vs ≈ $168 → high.)

### 5.4 Funding-rate sentiment (add-on #3)
- Display SPCX funding rate as crowding/sentiment: positive = longs paying (bullish/crowded, crash risk), negative = shorts paying. Pair with a persistent caution note referencing the May 28 2026 45% oracle flash crash, so viewers don't over-trust a single tick.

## 6. UI

- **Live data strip** (top): SPCX mark + 24h move, Polymarket-implied median cap & $/share, disagreement/confidence chip, funding chip, "Updated HH:MM UTC", **Refresh data** button, and a status badge (`Live` / amber `Last-known data`).
- **Weight slider** ("Hyperliquid ⇄ Polymarket") added to the existing controls (position size, allocation price, offer valuation, intraday vol, share count).
- Existing charts retained: Monte-Carlo fan, close histogram, low/high, survival; key metrics incl. P(close > $135).
- Caution pills retained/updated (unverified IPO inputs; synthetic-perp basis risk; flash-crash note).

## 7. Failure handling

Any fetch failure (network, rate-limit, CORS edge, schema change) → fall back to the **baked-in snapshot** (verified 2026-06-06 values), show amber "showing last-known data — APIs unreachable" badge, and keep the page fully functional. A shared visitor must **never** see a blank or broken page. Each source fails independently (HL can fall back while Polymarket succeeds).

## 8. Sharing & privacy

- Public repo (required for free Pages). Page contains a market model only — **no secrets, no personal financials, no API keys**.
- Link is public-but-unlisted; anyone with the URL can view. Acceptable for this content.

## 9. Testing / verification

- Serve locally; confirm both live fetches parse (SPCX price; 16 Polymarket buckets → monotonic curve).
- Force-fail each fetch independently; confirm fallback badge + functioning charts.
- Confirm realized-vol calc against a manual spot-check of the candle series.
- Render check via preview tool before pushing to Pages.
- After deploy: load the public URL in a clean browser, confirm live data appears and Refresh works.

## 10. File layout

```
spacex-ipo-model/
├── index.html              # the app (self-contained)
├── README.md               # what it is, the URL, data sources, caveats
└── docs/superpowers/specs/2026-06-06-spacex-ipo-live-model-design.md
```

## 11. Deployment

1. Commit `index.html` + `README.md`.
2. Create public GitHub repo `sage7one-spec/spacex-ipo-model`, push.
3. Enable Pages (branch `main`, root). URL: `https://sage7one-spec.github.io/spacex-ipo-model/`.
4. Verify live load; update project memory (`project_spacex_ipo_model.md`) with the URL and v2 note; keep frozen v1 untouched.

## 12. Known limitations (documented in-app)

- Both sources are **proxies** for the real stock; synthetic-perp basis risk means Day-1 actual may diverge then converge.
- Polymarket cap markets are **timing-contaminated** (resolve "No" if no IPO by Dec 2027); no separate timing market exists to strip this out.
- Live signals anchor the **close level**, not the intraday **path** (path stays model-driven).
- IPO date/offer price/valuation remain **user-supplied and unverified** (confirm with Fidelity).
