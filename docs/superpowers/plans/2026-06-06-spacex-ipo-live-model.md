# SpaceX IPO Live Model v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the static SpaceX IPO Day-1 model as a hosted page that fetches live Hyperliquid (`xyz:SPCX`) and Polymarket data on open, blends them into the close distribution, and is shareable via a public GitHub Pages URL.

**Architecture:** Pure model logic lives in a testable ES module `model.js` (no DOM, no network). `index.html` (ported from v1) does fetch + DOM + Chart.js, calling `model.js`. On any fetch failure it falls back to a baked-in snapshot so a shared link never breaks. Hosted on GitHub Pages.

**Tech Stack:** Vanilla JS (ES modules), Chart.js (CDN), Node 25 built-in test runner (`node --test`) with captured JSON fixtures, GitHub Pages.

---

## File Structure

```
spacex-ipo-model/
├── index.html                 # app: DOM, Chart.js, fetchLive(), fallback, render — ported from v1
├── model.js                   # PURE functions: parsing, stats, blend, simulation (testable)
├── snapshot.js                # BAKED_SNAPSHOT constant (verified 2026-06-06 fallback data)
├── README.md                  # what it is, URL, data sources, caveats
├── package.json               # {"type":"module"}, test script
├── test/
│   ├── model.test.js          # node --test unit tests for model.js
│   └── fixtures/
│       ├── hl-meta.json       # captured metaAndAssetCtxs (dex=xyz)
│       ├── hl-candles.json    # captured candleSnapshot (xyz:SPCX, 1h)
│       └── poly-event.json    # captured gamma /events?slug=spacex-ipo-closing-market-cap-above
└── docs/superpowers/{specs,plans}/...
```

`model.js` is imported by both `index.html` (`<script type="module">`) and the Node tests, so the same code is verified and shipped.

---

## Task 0: Scaffold project + capture real fixtures

**Files:**
- Create: `package.json`, `.gitignore`, `test/fixtures/hl-meta.json`, `test/fixtures/hl-candles.json`, `test/fixtures/poly-event.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "spacex-ipo-model",
  "version": "2.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
.DS_Store
node_modules/
```

- [ ] **Step 3: Capture live fixtures (real API responses) for deterministic tests**

```bash
cd /Users/davidlarson/Desktop/spacex-ipo-model
mkdir -p test/fixtures
curl -s -X POST https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' \
  -d '{"type":"metaAndAssetCtxs","dex":"xyz"}' -o test/fixtures/hl-meta.json
curl -s -X POST https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' \
  -d '{"type":"candleSnapshot","req":{"coin":"xyz:SPCX","interval":"1h","startTime":1779000000000}}' \
  -o test/fixtures/hl-candles.json
curl -s "https://gamma-api.polymarket.com/events?slug=spacex-ipo-closing-market-cap-above" \
  -o test/fixtures/poly-event.json
```

- [ ] **Step 4: Verify fixtures are non-empty and well-formed**

Run:
```bash
node -e "import('node:fs').then(fs=>{const a=JSON.parse(fs.readFileSync('test/fixtures/hl-meta.json'));console.log('hl universe assets:',a[0].universe.length);const c=JSON.parse(fs.readFileSync('test/fixtures/hl-candles.json'));console.log('candles:',c.length);const p=JSON.parse(fs.readFileSync('test/fixtures/poly-event.json'));console.log('poly markets:',(Array.isArray(p)?p[0]:p).markets.length);})"
```
Expected: `hl universe assets: 87` (±), `candles: 4xx`, `poly markets: 16`.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore test/fixtures
git commit -m "chore: scaffold v2 project and capture API fixtures"
```

---

## Task 1: `parseThresholdToCap` — parse "$1.4T?" → number

**Files:**
- Create: `model.js`
- Test: `test/model.test.js`

- [ ] **Step 1: Write the failing test** (create `test/model.test.js`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThresholdToCap } from '../model.js';

test('parseThresholdToCap handles $T and $B and decimals', () => {
  assert.equal(parseThresholdToCap('SpaceX IPO closing market cap above $1T?'), 1e12);
  assert.equal(parseThresholdToCap('...above $1.4T?'), 1.4e12);
  assert.equal(parseThresholdToCap('...above $800B?'), 800e9);
  assert.equal(parseThresholdToCap('no dollar amount here'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/model.test.js`
Expected: FAIL — `Cannot find module '../model.js'` / `parseThresholdToCap is not a function`.

- [ ] **Step 3: Write minimal implementation** (create `model.js`)

```js
// model.js — pure functions only (no DOM, no fetch). Imported by index.html and tests.

export function parseThresholdToCap(question) {
  const m = String(question).match(/\$([0-9]*\.?[0-9]+)\s*([TB])/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n * (m[2].toUpperCase() === 'T' ? 1e12 : 1e9);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add model.js test/model.test.js
git commit -m "feat: parseThresholdToCap"
```

---

## Task 2: `parsePolymarketCurve` — event JSON → monotonic survival curve

**Files:**
- Modify: `model.js`, `test/model.test.js`

- [ ] **Step 1: Write the failing test** (append to `test/model.test.js`)

```js
import { readFileSync } from 'node:fs';
import { parsePolymarketCurve } from '../model.js';

const polyEvent = JSON.parse(readFileSync(new URL('./fixtures/poly-event.json', import.meta.url)));

test('parsePolymarketCurve returns sorted, monotonic-non-increasing survival curve', () => {
  const curve = parsePolymarketCurve(polyEvent);
  assert.ok(curve.length >= 12, 'should parse most buckets');
  // sorted ascending by cap
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i].capT >= curve[i-1].capT);
  // P(above) monotonic non-increasing as cap rises
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i].pAbove <= curve[i-1].pAbove + 1e-9);
  // probabilities in [0,100]
  for (const r of curve) assert.ok(r.pAbove >= 0 && r.pAbove <= 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/model.test.js`
Expected: FAIL — `parsePolymarketCurve is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `model.js`)

```js
export function parsePolymarketCurve(eventJson) {
  const ev = Array.isArray(eventJson) ? eventJson[0] : eventJson;
  const rows = [];
  for (const mk of (ev?.markets || [])) {
    const cap = parseThresholdToCap(mk.question || '');
    if (cap == null) continue;
    let pr = mk.outcomePrices;
    if (typeof pr === 'string') { try { pr = JSON.parse(pr); } catch { continue; } }
    if (!pr || pr.length < 1) continue;
    const pAbove = parseFloat(pr[0]); // Yes price = P(cap > threshold)
    if (!isFinite(pAbove)) continue;
    rows.push({ capT: cap / 1e12, pAbove: pAbove * 100 });
  }
  rows.sort((a, b) => a.capT - b.capT);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].pAbove > rows[i-1].pAbove) rows[i].pAbove = rows[i-1].pAbove; // clamp thin-market noise
  }
  return rows; // [{capT in $T, pAbove in %}]
}

export function curveArrays(curve) {
  return { thresh: curve.map(r => r.capT), above: curve.map(r => r.pAbove) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add model.js test/model.test.js
git commit -m "feat: parsePolymarketCurve + curveArrays"
```

---

## Task 3: `medianCapT` + `sampleCap` — cap stats & inverse-CDF sampler (ported from v1)

**Files:**
- Modify: `model.js`, `test/model.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { mulberry32, medianCapT, sampleCap, curveArrays, parsePolymarketCurve as ppc2 } from '../model.js';

test('medianCapT brackets the 50% crossing', () => {
  const { thresh, above } = curveArrays(ppc2(polyEvent));
  const med = medianCapT(thresh, above);
  // today's data: median cap between $2.0T and $2.2T
  assert.ok(med > 1.8 && med < 2.6, `median cap ${med} out of expected range`);
});

test('sampleCap is deterministic under a seeded RNG and stays in plausible range', () => {
  const { thresh, above } = curveArrays(ppc2(polyEvent));
  const rng = mulberry32(20260611);
  const samples = Array.from({ length: 5000 }, () => sampleCap(thresh, above, rng));
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(mean > 1.5 && mean < 3.0, `mean cap ${mean} implausible`);
  // determinism: same seed → same first draw
  const r2 = mulberry32(20260611);
  assert.equal(sampleCap(thresh, above, r2), samples[0]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/model.test.js`
Expected: FAIL — `mulberry32 is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `model.js`)

```js
// Seeded RNG (ported from v1) — keeps results reproducible.
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export function gaussFrom(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Inverse-CDF sample of closing market cap ($T) from the survival curve (generalized from v1).
export function sampleCap(thresh, above, rng) {
  const u = rng() * 100, last = above.length - 1;
  if (u >= above[0]) { const f = (u - above[0]) / ((100 - above[0]) || 1); return thresh[0] * (1 - f * 0.15); }
  if (u <= above[last]) { const f = (above[last] - u) / (above[last] || 1); return thresh[last] + f * (thresh[last] * 0.375); }
  for (let i = 0; i < last; i++) {
    if (above[i] >= u && u >= above[i + 1]) {
      const f = (above[i] - u) / ((above[i] - above[i + 1]) || 1);
      return thresh[i] + f * (thresh[i + 1] - thresh[i]);
    }
  }
  return thresh[Math.floor(last / 2)];
}

// Polymarket-implied median closing cap ($T) via interpolation at the 50% crossing.
export function medianCapT(thresh, above) {
  const last = above.length - 1;
  for (let i = 0; i < last; i++) {
    if (above[i] >= 50 && 50 >= above[i + 1]) {
      const f = (above[i] - 50) / ((above[i] - above[i + 1]) || 1);
      return thresh[i] + f * (thresh[i + 1] - thresh[i]);
    }
  }
  return thresh[Math.floor(last / 2)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add model.js test/model.test.js
git commit -m "feat: mulberry32/gauss + sampleCap + medianCapT"
```

---

## Task 4: `parseHyperliquid` — meta+ctxs → SPCX price/funding

**Files:**
- Modify: `model.js`, `test/model.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { parseHyperliquid } from '../model.js';
const hlMeta = JSON.parse(readFileSync(new URL('./fixtures/hl-meta.json', import.meta.url)));

test('parseHyperliquid extracts xyz:SPCX mark/oracle/funding', () => {
  const hl = parseHyperliquid(hlMeta);
  assert.ok(hl, 'should find xyz:SPCX');
  assert.ok(hl.mark > 50 && hl.mark < 1000, `mark ${hl.mark} implausible`);
  assert.ok(isFinite(hl.oracle) && isFinite(hl.prevDay) && isFinite(hl.funding));
  assert.equal(parseHyperliquid([{ universe: [] }, []]), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/model.test.js`
Expected: FAIL — `parseHyperliquid is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `model.js`)

```js
export function parseHyperliquid(metaAndCtxs, coin = 'xyz:SPCX') {
  if (!Array.isArray(metaAndCtxs) || metaAndCtxs.length < 2) return null;
  const [meta, ctxs] = metaAndCtxs;
  const i = (meta?.universe || []).findIndex(a => a.name === coin);
  if (i < 0) return null;
  const c = ctxs[i] || {};
  return {
    mark: +c.markPx, oracle: +c.oraclePx,
    prevDay: +c.prevDayPx, funding: +c.funding
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add model.js test/model.test.js
git commit -m "feat: parseHyperliquid"
```

---

## Task 5: `realizedVolFromCandles` — real SPCX vol → slider default (add-on #1)

**Files:**
- Modify: `model.js`, `test/model.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { realizedVolFromCandles } from '../model.js';
const hlCandles = JSON.parse(readFileSync(new URL('./fixtures/hl-candles.json', import.meta.url)));

test('realizedVolFromCandles returns positive sigmas and a 0-100 slider value', () => {
  const v = realizedVolFromCandles(hlCandles);
  assert.ok(v && v.hourlySigma > 0 && v.dailySigma > v.hourlySigma);
  assert.ok(v.sliderVal >= 0 && v.sliderVal <= 100);
  assert.equal(realizedVolFromCandles([]), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/model.test.js`
Expected: FAIL — `realizedVolFromCandles is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `model.js`)

```js
// Hourly candles → realized vol. Maps daily sigma into v1's slider band: sigMid = 0.02 + 0.18*(slider/100).
export function realizedVolFromCandles(candles) {
  const closes = (candles || []).map(k => +k.c).filter(x => isFinite(x) && x > 0);
  if (closes.length < 3) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rets.length - 1);
  const hourlySigma = Math.sqrt(varr);
  const dailySigma = hourlySigma * Math.sqrt(6.5); // ~6.5 trading hours/session
  const sliderVal = Math.max(0, Math.min(100, Math.round((dailySigma - 0.02) / 0.18 * 100)));
  return { hourlySigma, dailySigma, sliderVal };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add model.js test/model.test.js
git commit -m "feat: realizedVolFromCandles (add-on #1)"
```

---

## Task 6: `disagreement` + `blendCenter` — confidence gauge & blend math (add-on #2)

**Files:**
- Modify: `model.js`, `test/model.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { disagreement, blendCenter } from '../model.js';

test('disagreement tiers by relative spread', () => {
  assert.equal(disagreement(165, 168).tier, 'high');    // ~1.8%
  assert.equal(disagreement(165, 185).tier, 'moderate'); // ~11%
  assert.equal(disagreement(165, 230).tier, 'low');      // ~33%
});

test('blendCenter interpolates between sources by weight w', () => {
  assert.equal(blendCenter(160, 200, 0), 200); // w=0 → pure Polymarket
  assert.equal(blendCenter(160, 200, 1), 160); // w=1 → pure Hyperliquid
  assert.equal(blendCenter(160, 200, 0.5), 180);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/model.test.js`
Expected: FAIL — `disagreement is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `model.js`)

```js
export function disagreement(hlMark, polyMedianPerShare) {
  const avg = (hlMark + polyMedianPerShare) / 2;
  const absPct = avg > 0 ? Math.abs(hlMark - polyMedianPerShare) / avg : 0;
  const tier = absPct < 0.05 ? 'high' : absPct < 0.15 ? 'moderate' : 'low';
  return { absPct, tier, deltaUsd: hlMark - polyMedianPerShare };
}

export function blendCenter(hlMark, polyMedianPerShare, w) {
  return w * hlMark + (1 - w) * polyMedianPerShare;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add model.js test/model.test.js
git commit -m "feat: disagreement gauge + blendCenter (add-on #2)"
```

---

## Task 7: `simulateDayOne` — blended Monte Carlo (ported & parameterized from v1)

**Files:**
- Modify: `model.js`, `test/model.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { simulateDayOne } from '../model.js';

test('simulateDayOne produces well-formed, deterministic, blend-responsive output', () => {
  const { thresh, above } = curveArrays(ppc2(polyEvent));
  const shares = 12.96e9;
  const base = { thresh, above, shares, offer: 135, vol: 60, N: 3000, steps: 8 };

  const a = simulateDayOne({ ...base, hlMark: 165, w: 0.5, rng: mulberry32(20260611) });
  assert.equal(a.closes.length, 3000);
  assert.equal(a.grid.length, 9);            // steps+1 time nodes
  assert.equal(a.grid[0].length, 3000);
  assert.ok(a.closes.every(x => x > 0));

  // determinism: same seed → identical center
  const b = simulateDayOne({ ...base, hlMark: 165, w: 0.5, rng: mulberry32(20260611) });
  assert.equal(a.center, b.center);

  // blend responds to w: higher Hyperliquid weight pulls center toward a higher hlMark
  const lowHL  = simulateDayOne({ ...base, hlMark: 250, w: 0.0, rng: mulberry32(1) });
  const highHL = simulateDayOne({ ...base, hlMark: 250, w: 1.0, rng: mulberry32(1) });
  assert.ok(highHL.center > lowHL.center, 'w=1 should pull center toward hlMark=250');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/model.test.js`
Expected: FAIL — `simulateDayOne is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `model.js`)

```js
// Historical Day-1 open->close returns (mega-IPO base rates, from v1).
const OPEN_TO_CLOSE = [0.073, 0.134, -0.056, -0.138, -0.009, 0.036, 0.042, -0.109, -0.084, -0.091, -0.103, -0.010, 0.041];

export function simulateDayOne(cfg) {
  const { thresh, above, shares, hlMark, w, offer, vol, N = 10000, steps = 8, rng } = cfg;
  const gauss = () => gaussFrom(rng);
  const polyMedCap = medianCapT(thresh, above);          // $T
  const polyMedPerShare = polyMedCap * 1e12 / shares;    // $/share
  const center = blendCenter(hlMark, polyMedPerShare, w);// $/share
  const factor = polyMedPerShare > 0 ? center / polyMedPerShare : 1; // multiplicative re-center (keeps shape)
  const n = steps, sigMid = 0.02 + 0.18 * (vol / 100), s = 2 * sigMid / Math.sqrt(n);
  const closes = [], lows = [], highs = [], grid = Array.from({ length: n + 1 }, () => []);
  for (let p = 0; p < N; p++) {
    const cap = sampleCap(thresh, above, rng);           // $T
    const C = (cap * 1e12 / shares) * factor;            // $/share, blended close
    const oc = OPEN_TO_CLOSE[Math.floor(rng() * OPEN_TO_CLOSE.length)] + gauss() * 0.02;
    const O = C / (1 + oc);                              // opening print
    const lO = Math.log(O), lC = Math.log(C);
    let W = 0; const Wk = [0];
    for (let k = 1; k <= n; k++) { W += gauss() * s; Wk.push(W); }
    const Wn = Wk[n];
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k <= n; k++) {
      const bb = Wk[k] - (k / n) * Wn;
      const price = Math.exp(lO + (lC - lO) * (k / n) + bb);
      grid[k].push(price);
      if (price < lo) lo = price;
      if (price > hi) hi = price;
    }
    closes.push(C); lows.push(lo); highs.push(hi);
  }
  return { closes, lows, highs, grid, entry: offer, center, polyMedPerShare };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/model.test.js`
Expected: PASS. Also run full suite `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add model.js test/model.test.js
git commit -m "feat: simulateDayOne blended Monte Carlo"
```

---

## Task 8: `snapshot.js` — baked-in fallback data (verified 2026-06-06)

**Files:**
- Create: `snapshot.js`

- [ ] **Step 1: Generate the snapshot from the captured fixtures** (so it matches the parsers exactly)

Run:
```bash
cd /Users/davidlarson/Desktop/spacex-ipo-model
node -e "
import('./model.js').then(async m => {
  const fs = await import('node:fs');
  const hl = m.parseHyperliquid(JSON.parse(fs.readFileSync('test/fixtures/hl-meta.json')));
  const curve = m.parsePolymarketCurve(JSON.parse(fs.readFileSync('test/fixtures/poly-event.json')));
  const vol = m.realizedVolFromCandles(JSON.parse(fs.readFileSync('test/fixtures/hl-candles.json')));
  const out = 'export const BAKED_SNAPSHOT = ' + JSON.stringify({ asOf: '2026-06-06', hl, curve, vol }, null, 2) + ';\n';
  fs.writeFileSync('snapshot.js', out);
  console.log('wrote snapshot.js:', JSON.stringify({mark:hl.mark, buckets:curve.length, sliderVal:vol.sliderVal}));
});
"
```
Expected: prints `mark`, `buckets: 16`, a `sliderVal`. `snapshot.js` now exists exporting `BAKED_SNAPSHOT` with `{asOf, hl:{mark,oracle,prevDay,funding}, curve:[{capT,pAbove}], vol:{hourlySigma,dailySigma,sliderVal}}`.

- [ ] **Step 2: Commit**

```bash
git add snapshot.js
git commit -m "feat: baked-in fallback snapshot (2026-06-06)"
```

---

## Task 9: `index.html` — port v1, wire to model.js, add live UI (snapshot-only first)

This task gets a fully working page using ONLY the baked snapshot (no network yet), so we verify the model/render path in isolation before adding fetch.

**Files:**
- Create: `index.html` (start from v1 at `/Users/davidlarson/Desktop/spacex-ipo-dashboard/spacex-ipo-trading-model.html`)

- [ ] **Step 1: Copy v1 as the base**

```bash
cp "/Users/davidlarson/Desktop/spacex-ipo-dashboard/spacex-ipo-trading-model.html" \
   /Users/davidlarson/Desktop/spacex-ipo-model/index.html
```

- [ ] **Step 2: Replace the inline `<script>` block with a module that imports model.js + snapshot.js**

In `index.html`, change the opening simulation script tag from `<script>` to `<script type="module">`, and replace the v1 model internals (the `PM_THRESH`/`PM_ABOVE` constants, `mulberry32`, `gauss`, `sampleCap`, `medianClose`, `simulate`) with imports. At the top of the module:

```js
import { mulberry32, parsePolymarketCurve, curveArrays, parseHyperliquid,
         realizedVolFromCandles, medianCapT, disagreement, simulateDayOne } from './model.js';
import { BAKED_SNAPSHOT } from './snapshot.js';

// Live data store — starts as the baked snapshot, replaced by fetchLive() in Task 10.
const live = {
  hl: BAKED_SNAPSHOT.hl,
  curve: BAKED_SNAPSHOT.curve,
  vol: BAKED_SNAPSHOT.vol,
  asOf: BAKED_SNAPSHOT.asOf,
  status: 'snapshot'   // 'live' | 'snapshot' | 'partial'
};

const state = { pos:100000, offer:135, shares:12.96e9, w:0.5, vol:BAKED_SNAPSHOT.vol.sliderVal, N:10000, steps:8 };
let SEED = 20260611;
let rng = mulberry32(SEED);
function reseed(){ rng = mulberry32(SEED); }
```

- [ ] **Step 3: Replace `render()`'s simulate call and derived/pill text to use the blended model**

Replace the body of `render()` so it calls the imported `simulateDayOne` and reads live data:

```js
function render(){
  reseed();
  const { thresh, above } = curveArrays(live.curve);
  const sim = simulateDayOne({ thresh, above, shares: state.shares, hlMark: live.hl.mark,
                               w: state.w, offer: state.offer, vol: state.vol, N: state.N, steps: state.steps, rng });
  const { closes, lows, highs, grid, entry } = sim;
  const polyMedPerShare = sim.polyMedPerShare;
  const dis = disagreement(live.hl.mark, polyMedPerShare);

  const pProfit = fracAbove(closes, entry);
  const meanC = mean(closes), evRet = meanC/entry - 1, evDol = state.pos*evRet;
  const pUnder = fracBelow(lows, entry);
  const medLow = pctile(lows,.5)/entry - 1, medHigh = pctile(highs,.5)/entry - 1;
  const shares = state.pos/entry;

  setText('ppPill', (pProfit*100).toFixed(0)+'%');
  setText('derived',
    `Blended close ≈ $${sim.center.toFixed(0)} · Hyperliquid $${live.hl.mark.toFixed(2)} ⇄ Polymarket-implied $${polyMedPerShare.toFixed(0)} · you hold ≈ ${Math.round(shares).toLocaleString()} sh`);

  updateLiveStrip(dis);   // defined in Step 4
  // ... metric cards, verdict: keep v1 code verbatim (they read closes/lows/highs/entry) ...
  drawFan(grid, entry); drawClose(closes, entry); drawRange(lows, highs, entry); drawSurv(thresh, above);
}
```

Keep the v1 metric-card and verdict DOM-building code unchanged. Update `drawSurv()` to take `(thresh, above)` and plot the live curve instead of the removed constants:

```js
function drawSurv(thresh, above){
  if(survChart) survChart.destroy();
  survChart = new Chart(document.getElementById('survChart'), { type:'line',
    data:{ labels: thresh.map(t=>'$'+t.toFixed(1)+'T'),
      datasets:[{ data: above, borderColor:PUR, backgroundColor:'rgba(124,92,255,.12)',
        borderWidth:2.5, pointRadius:3, pointBackgroundColor:PUR, fill:true, tension:.2 }] },
    options: baseOpts({ scales:{ x:{grid:{color:GRID},ticks:{color:TICK,maxTicksLimit:9}},
      y:{grid:{color:GRID},ticks:{color:TICK,callback:v=>v+'%'},min:0,max:100} },
      plugins:{ legend:{display:false}, tooltip:{callbacks:{label:c=>'P(cap > '+c.label+') = '+(+c.raw).toFixed(0)+'%'}} } }) });
}
```

- [ ] **Step 4: Add the live data strip DOM + helpers**

In the header (after the existing pills `<div>`), add the strip container:

```html
<div id="liveStrip" class="card" style="margin-top:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px">
  <span id="liveBadge" class="pill">snapshot</span>
  <span>SPCX <b id="hlMark">—</b> <span id="hlChg" class="s"></span></span>
  <span>Poly median/sh <b id="polyPx">—</b></span>
  <span id="disChip" class="pill"></span>
  <span id="fundChip" class="pill"></span>
  <span class="s" id="asOf"></span>
  <button class="btn" id="refresh">⟳ Refresh data</button>
</div>
```

Add the new weight + shares controls to the `.controls` grid (replace the v1 "Offer valuation" control, which the blend logic makes obsolete):

```html
<div class="ctl"><label>Hyperliquid ⇄ Polymarket weight <span class="val" id="wLbl">50%</span></label>
  <input type="range" id="w" min="0" max="100" value="50"><div class="hint" style="margin-top:6px">0% = pure Polymarket close · 100% = pure Hyperliquid mark.</div></div>
<div class="ctl"><label>Shares outstanding <span class="val" id="shLbl">12.96B</span></label>
  <input type="number" id="shares" value="12.96" min="1" max="30" step="0.01"><div class="hint" style="margin-top:6px">Converts Polymarket market-cap odds → $/share.</div></div>
```

Add the helper + new bindings to the module:

```js
function updateLiveStrip(dis){
  const hl = live.hl;
  setText('hlMark', '$'+hl.mark.toFixed(2));
  const chg = hl.prevDay ? (hl.mark/hl.prevDay - 1) : 0;
  setText('hlChg', (chg>=0?'+':'')+(chg*100).toFixed(1)+'% 24h');
  setText('polyPx', '$'+ (medianCapT(...Object.values(curveArrays(live.curve)))*1e12/state.shares).toFixed(0));
  const b = document.getElementById('liveBadge');
  b.textContent = live.status==='live' ? 'live' : live.status==='partial' ? 'partial (some last-known)' : 'last-known data';
  b.className = 'pill '+(live.status==='live'?'green':'warn');
  const dc = document.getElementById('disChip');
  dc.textContent = 'agreement: '+dis.tier+' ('+(dis.absPct*100).toFixed(0)+'%)';
  dc.className = 'pill '+(dis.tier==='high'?'green':dis.tier==='low'?'warn':'');
  const fc = document.getElementById('fundChip');
  const f = live.hl.funding||0;
  fc.textContent = 'funding '+(f>=0?'+':'')+(f*100).toFixed(4)+'% '+(f>=0?'(longs pay)':'(shorts pay)');
  fc.className = 'pill';
  setText('asOf', 'as of '+live.asOf);
}
```

In `bind()`, remove the `val` handler and add:

```js
g('w').addEventListener('input', e=>{ state.w=(+e.target.value)/100; setText('wLbl', e.target.value+'%'); render(); });
g('shares').addEventListener('input', e=>{ state.shares=Math.max(1,(+e.target.value||12.96))*1e9; setText('shLbl', (state.shares/1e9).toFixed(2)+'B'); render(); });
g('vol').setAttribute('value', state.vol); // reflect realized-vol default
g('refresh').addEventListener('click', ()=>{ fetchLive(); }); // fetchLive defined in Task 10; safe no-op stub until then
```

Add a temporary stub at the end of the module so Step-9 page runs before Task 10:

```js
async function fetchLive(){ render(); } // replaced in Task 10
```

- [ ] **Step 5: Verify the snapshot-only page renders**

Run:
```bash
cd /Users/davidlarson/Desktop/spacex-ipo-model && python3 -m http.server 8765 >/tmp/spx.log 2>&1 &
sleep 1 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8765/index.html
```
Expected: `200`. Then open `http://localhost:8765/index.html` in a browser (or the preview tool) and confirm: charts render, the live strip shows the snapshot values, the weight slider moves the median, no console errors. Stop the server: `kill %1`.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: index.html ported to model.js with live UI (snapshot-only)"
```

---

## Task 10: `fetchLive()` — real Hyperliquid + Polymarket fetch with per-source fallback

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Replace the `fetchLive` stub with the real implementation**

```js
const HL_URL = 'https://api.hyperliquid.xyz/info';
const POLY_URL = 'https://gamma-api.polymarket.com/events?slug=spacex-ipo-closing-market-cap-above';

async function fetchHyperliquid(){
  const [metaRes, candleRes] = await Promise.all([
    fetch(HL_URL,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({type:'metaAndAssetCtxs',dex:'xyz'})}),
    fetch(HL_URL,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({type:'candleSnapshot',req:{coin:'xyz:SPCX',interval:'1h',startTime:Date.now()-1000*60*60*24*21}})})
  ]);
  const hl = parseHyperliquid(await metaRes.json());
  const vol = realizedVolFromCandles(await candleRes.json());
  if(!hl) throw new Error('SPCX not found');
  return { hl, vol };
}
async function fetchPolymarket(){
  const ev = await (await fetch(POLY_URL)).json();
  const curve = parsePolymarketCurve(ev);
  if(!curve.length) throw new Error('no Polymarket buckets');
  return curve;
}

async function fetchLive(){
  const badge = document.getElementById('liveBadge');
  badge.textContent='loading…'; badge.className='pill';
  let okHL=false, okPoly=false;
  try { const r = await fetchHyperliquid(); live.hl=r.hl; if(r.vol){ live.vol=r.vol; state.vol=r.vol.sliderVal;
        const vEl=document.getElementById('vol'); if(vEl){ vEl.value=r.vol.sliderVal; setText('volLbl', r.vol.sliderVal);} } okHL=true; }
  catch(e){ console.warn('HL fetch failed', e); live.hl=BAKED_SNAPSHOT.hl; }
  try { live.curve = await fetchPolymarket(); okPoly=true; }
  catch(e){ console.warn('Poly fetch failed', e); live.curve=BAKED_SNAPSHOT.curve; }
  live.status = (okHL&&okPoly) ? 'live' : (okHL||okPoly) ? 'partial' : 'snapshot';
  live.asOf = (okHL||okPoly) ? new Date().toISOString().slice(0,16).replace('T',' ')+' UTC' : BAKED_SNAPSHOT.asOf;
  render();
}
```

- [ ] **Step 2: Trigger an initial fetch on load**

Change the boot line from `}else{bind();render();}` to:

```js
} else { bind(); render(); fetchLive(); }
```

(`render()` draws immediately from the snapshot so the page is never blank; `fetchLive()` then upgrades it to live.)

- [ ] **Step 3: Verify live fetch in a browser**

Run:
```bash
cd /Users/davidlarson/Desktop/spacex-ipo-model && python3 -m http.server 8765 >/tmp/spx.log 2>&1 &
sleep 1
```
Open `http://localhost:8765/index.html`. Confirm: badge flips `loading…` → `live`, SPCX price matches the current `xyz:SPCX` mark, `as of` shows the current UTC time, agreement chip shows a tier, no CORS errors in console. Click **Refresh data** → values re-pull.

- [ ] **Step 4: Verify graceful fallback (force-fail)**

In the browser devtools console, run `HL_URL` is module-scoped so instead test fallback by going offline: in devtools Network tab enable "Offline", click **Refresh data**. Expected: badge shows `last-known data` (amber), charts still render from the snapshot, no uncaught errors. Re-enable network, Refresh → back to `live`. Stop server: `kill %1`.

- [ ] **Step 5: Run the full unit suite once more (model untouched but confirm green)**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: live Hyperliquid + Polymarket fetch with per-source fallback"
```

---

## Task 11: README, footer/caveat updates, deploy to GitHub Pages, update memory

**Files:**
- Create: `README.md`
- Modify: `index.html` (footer text), project memory

- [ ] **Step 1: Update the footer/disclaimer text in `index.html`**

Replace the v1 "Data via crawl4ai · 2026-06-04" pill and the `Sources`/`How it works` footer to reflect live data: mention Hyperliquid `xyz:SPCX` (synthetic perp, basis risk, May 28 flash-crash caveat), live Polymarket cap markets, and that live data anchors the close *level* while the path is model-driven. Keep the "Not financial advice" disclaimer block.

- [ ] **Step 2: Write `README.md`**

```markdown
# SpaceX IPO — Day-1 Live Model

Live, browser-based Monte-Carlo model of SpaceX's Day-1 intraday price for a $135 pre-IPO
allocation. Pulls fresh data on every load:

- **Hyperliquid** `xyz:SPCX` synthetic pre-IPO perp — live per-share mark price.
- **Polymarket** "closing market cap above $X" markets — crowd-sourced close distribution.

The close is a blend (weight slider): Hyperliquid sets the center, Polymarket sets the spread.
If either API is unreachable the page falls back to a baked-in snapshot and flags it.

**Live:** https://sage7one-spec.github.io/spacex-ipo-model/

## Develop
- `npm test` — unit tests (Node 25 built-in runner) for the pure model in `model.js`.
- `python3 -m http.server 8765` then open http://localhost:8765/ — run locally.

## Caveats
Both sources are proxies for the real stock (synthetic-perp basis risk; Polymarket markets are
timing-contaminated and resolve "No" if no IPO by Dec 2027). Live data anchors the close *level*,
not the intraday *path*. IPO date/price/valuation are user-supplied and unverified. Not financial advice.
```

- [ ] **Step 3: Commit**

```bash
git add README.md index.html
git commit -m "docs: README + live-data footer/caveats"
```

- [ ] **Step 4: Push to the GitHub repo** (created by user at github.com/sage7one-spec/spacex-ipo-model)

```bash
cd /Users/davidlarson/Desktop/spacex-ipo-model
git branch -M main
git remote add origin git@github.com:sage7one-spec/spacex-ipo-model.git
git push -u origin main
```
Expected: push succeeds. (If the remote already has commits, `git pull --rebase origin main` first.)

- [ ] **Step 5: Enable GitHub Pages (manual, web UI — `gh` not installed)**

Tell the user: in the repo on github.com → **Settings → Pages → Build and deployment → Source: "Deploy from a branch" → Branch: `main` / `/ (root)` → Save**. Wait ~1 min.

- [ ] **Step 6: Verify the live URL**

Run:
```bash
sleep 60 && curl -s -o /dev/null -w "%{http_code}\n" https://sage7one-spec.github.io/spacex-ipo-model/
```
Expected: `200`. Open the URL in a browser; confirm live data loads and Refresh works. Send the link to a test recipient / open in a private window to confirm it's publicly viewable.

- [ ] **Step 7: Update project memory**

Edit `/Users/davidlarson/.claude/projects/-Users-davidlarson/memory/project_spacex_ipo_model.md`: add the v2 note — live Hyperliquid+Polymarket fetch, GitHub Pages URL `https://sage7one-spec.github.io/spacex-ipo-model/`, repo `sage7one-spec/spacex-ipo-model`, working dir `~/Desktop/spacex-ipo-model`. Keep the frozen v1 reference. Update the MEMORY.md one-liner hook.

- [ ] **Step 8: Final commit (if any local doc/memory artifacts changed in-repo)**

```bash
git add -A && git commit -m "chore: v2 live model deployed to GitHub Pages" || echo "nothing to commit"
git push
```

---

## Self-Review notes

- **Spec coverage:** hosting/shareable (Task 11) ✓; live fetch on open + Refresh (Task 10) ✓; blend center+spread with weight slider (Tasks 6–9) ✓; add-on #1 realized vol (Task 5, wired Task 10) ✓; add-on #2 disagreement gauge (Task 6, wired Task 9) ✓; add-on #3 funding sentiment + crash caution (Task 9 strip, Task 11 footer) ✓; per-source fallback snapshot (Tasks 8, 10) ✓; documented limitations (Task 11) ✓.
- **Type consistency:** `curveArrays` → `{thresh, above}` used consistently; `parseHyperliquid` → `{mark,oracle,prevDay,funding}` used in strip + sim; `simulateDayOne` returns `{closes,lows,highs,grid,entry,center,polyMedPerShare}` consumed by `render`. `live` shape `{hl,curve,vol,asOf,status}` consistent across Tasks 9–10.
- **YAGNI:** float-scarcity premium and convergence weighting intentionally excluded per spec.
