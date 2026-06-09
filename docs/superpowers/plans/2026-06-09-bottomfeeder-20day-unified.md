# Bottom-Feeder + 20-Day Engine + Unified $100k Reporting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Day-1 open-market "bottom-feeder" strategy (Case B), replace the static Day-16 logic with a 20-day probabilistic fan-chart engine (Case C), and unify all reporting to a fixed $100,000 cost basis rendered in net absolute dollars.

**Architecture:** All new math is pure, seeded, and unit-tested in `model.js` (node:test). `index.html` gains render sections that consume those functions; it is verified by loading the local server (no DOM unit tests exist in this repo). Live-fetch + baked-snapshot fallback is untouched.

**Tech Stack:** Vanilla ES modules, Chart.js (already loaded in `index.html`), Node's built-in test runner (`node --test`).

**Spec:** `docs/superpowers/specs/2026-06-09-day1-bottomfeeder-20day-design.md`

**Branch:** `feat/bottomfeeder-20day-unified` (already created; spec already committed).

---

## File Structure

- `model.js` — add: `netDollars`, `fmtNet`, `simulateBottomFeed`, `bottomFeedTicket`, `MEGA_IPO_POSTIPO_CURVE`, `simulatePostIPO`, `postIpoBands`. Remove: `simulateDay16`, `buildDay16Policy`.
- `test/model.test.js` — add tests for the new functions; remove the three Day-16 tests and the `simulateDay16, buildDay16Policy` import.
- `index.html` — change default position to $100k; convert Case A headline figures to net $; add the Case B section; replace the Day-16 comparison with the 20-day fan; add the Three-Strategy Scorecard.
- `README.md` — update layout/section text and add the blending-weights writeup.

---

## Task 1: Reporting helpers (`netDollars`, `fmtNet`)

**Files:**
- Modify: `model.js` (append near the top exports, after `mulberry32`/`gaussFrom` block or at file end)
- Test: `test/model.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `test/model.test.js` (and add `netDollars, fmtNet` to the import block from `../model.js`):

```js
test('netDollars subtracts the $100k basis by default', () => {
  assert.equal(netDollars(125000), 25000);
  assert.equal(netDollars(88000), -12000);
  assert.equal(netDollars(100000), 0);
  assert.equal(netDollars(150000, 150000), 0);
});

test('fmtNet renders signed absolute dollars with thousands separators', () => {
  assert.equal(fmtNet(25000), '+$25,000');
  assert.equal(fmtNet(-12300), '-$12,300');
  assert.equal(fmtNet(0), '$0');
  assert.equal(fmtNet(-0.4), '$0');      // rounds to zero → no sign
  assert.equal(fmtNet(999.6), '+$1,000');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `netDollars is not defined` / `fmtNet is not defined`.

- [ ] **Step 3: Implement**

Append to `model.js`:

```js
// ---- Reporting helpers (Phase 3): everything is net absolute dollars on a fixed basis ----

export function netDollars(proceeds, capital = 100000) {
  return proceeds - capital;
}

// Signed absolute-dollar string. Rounds to whole dollars; exact zero prints unsigned "$0".
export function fmtNet(dollars) {
  const r = Math.round(dollars);
  if (r === 0) return '$0';
  return `${r > 0 ? '+' : '-'}$${Math.abs(r).toLocaleString('en-US')}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS for the two new tests.

- [ ] **Step 5: Commit**

```bash
git add model.js test/model.test.js
git commit -m "feat(report): netDollars + fmtNet — net absolute-dollar primary metric"
```

---

## Task 2: Case B engine (`simulateBottomFeed`)

**Files:**
- Modify: `model.js`
- Test: `test/model.test.js`

Operates on a price grid (`paths.grid`, shape `[steps+1][N]`, same shape `simulateDayOne` returns). A path fills the limit buy on the first step ≤ `limitPx`, then exits via an OCO bracket (target checked before stop within a step), residual to close. No fill → exactly $0 net.

- [ ] **Step 1: Write the failing tests**

Add `simulateBottomFeed` to the import block, then add:

```js
// Helper: build a paths object from explicit per-step price columns (one path).
function gridFromPath(prices) { return { grid: prices.map(px => [px]) }; }

test('simulateBottomFeed: no step <= limit → $0 net, capital preserved', () => {
  const paths = gridFromPath([200, 190, 180, 170]); // never dips to 135
  const r = simulateBottomFeed(paths, { limitPx: 135, capital: 100000, targetPct: 0.06, stopPct: 0.05 });
  assert.equal(r.pFill, 0);
  assert.equal(r.pNoFill, 1);
  assert.equal(r.nets[0], 0);
  assert.equal(r.net.mean, 0);
  assert.equal(r.mix.noFillPct, 1);
});

test('simulateBottomFeed: dip to limit then rally → exit at target (+6%)', () => {
  // fills at 135 (step 1), then step 3 hits >= 143.10 target
  const paths = gridFromPath([150, 135, 138, 145]);
  const r = simulateBottomFeed(paths, { limitPx: 135, capital: 100000, targetPct: 0.06, stopPct: 0.05 });
  const shares = 100000 / 135, target = 135 * 1.06;
  assert.equal(r.pFill, 1);
  assert.ok(Math.abs(r.nets[0] - (shares * target - 100000)) < 1e-6);
  assert.equal(r.mix.targetPct, 1);
});

test('simulateBottomFeed: dip to limit then break down → exit at stop (-5%)', () => {
  const paths = gridFromPath([150, 135, 130, 120]); // stop = 128.25 hit at step 3
  const r = simulateBottomFeed(paths, { limitPx: 135, capital: 100000, targetPct: 0.06, stopPct: 0.05 });
  const shares = 100000 / 135, stop = 135 * 0.95;
  assert.ok(Math.abs(r.nets[0] - (shares * stop - 100000)) < 1e-6);
  assert.equal(r.mix.stopPct, 1);
});

test('simulateBottomFeed: fill but neither target nor stop → residual sells at close', () => {
  const paths = gridFromPath([150, 135, 137, 138]); // never reaches 143.10 or 128.25
  const r = simulateBottomFeed(paths, { limitPx: 135, capital: 100000, targetPct: 0.06, stopPct: 0.05 });
  const shares = 100000 / 135;
  assert.ok(Math.abs(r.nets[0] - (shares * 138 - 100000)) < 1e-6);
  assert.equal(r.mix.closePct, 1);
});

test('simulateBottomFeed: mix fractions sum to 1', () => {
  const paths = { grid: [
    [200, 150, 150, 150], // no fill
    [135, 135, 130, 120], // fill→? step0 fill, target before stop: step1=135<143.1, not stop(128.25); step2=130; step3=120<=128.25 stop
  ].reduce((cols, path) => { path.forEach((px, k) => { (cols[k] ||= []).push(px); }); return cols; }, []) };
  const r = simulateBottomFeed(paths, { limitPx: 135, capital: 100000, targetPct: 0.06, stopPct: 0.05 });
  const m = r.mix;
  assert.ok(Math.abs((m.targetPct + m.stopPct + m.closePct + m.noFillPct) - 1) < 1e-9);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `simulateBottomFeed is not defined`.

- [ ] **Step 3: Implement**

Append to `model.js`:

```js
// ---- Case B: open-market bottom-feeder (Phase 1) -----------------------------
// Buys the full capital at a limit (default $135) the first step price <= limitPx,
// then exits via an OCO bracket: sell-limit at +targetPct, sell-stop at -stopPct,
// target checked BEFORE stop within a step. Residual sells at the close. If no step
// ever reaches the limit, the path records exactly $0 net (capital preserved).
export function simulateBottomFeed(paths, cfg) {
  const { grid } = paths;
  const steps = grid.length - 1, N = grid[0].length;
  const { limitPx = 135, capital = 100000, targetPct = 0.06, stopPct = 0.05 } = cfg;
  const target = limitPx * (1 + targetPct);
  const stop = limitPx * (1 - stopPct);
  const shares = capital / limitPx;
  const nets = new Array(N);
  let fills = 0, targetHits = 0, stopHits = 0, closeHits = 0, noFill = 0;

  for (let p = 0; p < N; p++) {
    let kFill = -1;
    for (let k = 0; k <= steps; k++) { if (grid[k][p] <= limitPx) { kFill = k; break; } }
    if (kFill < 0) { nets[p] = 0; noFill++; continue; }   // No-Execution safety state
    fills++;
    let exitPx = null;
    for (let k = kFill + 1; k <= steps; k++) {
      const price = grid[k][p];
      if (price >= target) { exitPx = target; targetHits++; break; }  // target before stop
      if (price <= stop)   { exitPx = stop;   stopHits++;   break; }
    }
    if (exitPx == null) { exitPx = grid[steps][p]; closeHits++; }      // residual to close
    nets[p] = shares * exitPx - capital;
  }

  const sorted = [...nets].sort((a, b) => a - b);
  const pct = (q) => { const i = (N - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
  const mean = nets.reduce((a, b) => a + b, 0) / N;
  return {
    pFill: fills / N, pNoFill: noFill / N,
    net: { mean, median: pct(0.5), p5: pct(0.05), p95: pct(0.95) },
    mix: { targetPct: targetHits / N, stopPct: stopHits / N, closePct: closeHits / N, noFillPct: noFill / N },
    nets, shares,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS for all five Case B tests.

- [ ] **Step 5: Commit**

```bash
git add model.js test/model.test.js
git commit -m "feat(caseB): simulateBottomFeed — limit fill + OCO bracket + \$0 no-fill state"
```

---

## Task 3: Case B Fidelity ticket (`bottomFeedTicket`)

**Files:**
- Modify: `model.js`
- Test: `test/model.test.js`

- [ ] **Step 1: Write the failing test**

Add `bottomFeedTicket` to the import block, then:

```js
test('bottomFeedTicket: buy-limit + OCO bracket + MOC residual', () => {
  const t = bottomFeedTicket({ limitPx: 135, capital: 100000, targetPct: 0.06, stopPct: 0.05 });
  assert.equal(t.entry.type, 'BUY LIMIT');
  assert.equal(t.entry.shares, Math.round(100000 / 135)); // 741
  assert.equal(t.entry.limitPx, 135);
  assert.equal(t.bracket.sellLimitPx, +(135 * 1.06).toFixed(2)); // 143.10
  assert.equal(t.bracket.sellStopPx, +(135 * 0.95).toFixed(2));  // 128.25
  assert.equal(t.residual.type, 'MOC');
  assert.ok(t.entry.note.includes('keep'));   // no-fill safety messaging
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `bottomFeedTicket is not defined`.

- [ ] **Step 3: Implement**

Append to `model.js`:

```js
// Fidelity ATP order set for Case B: a buy-limit at/below the limit, an OCO bracket
// attached on fill, and an MOC/LOC residual. Mirrors the bottom-feeder execution.
export function bottomFeedTicket(cfg) {
  const { limitPx = 135, capital = 100000, targetPct = 0.06, stopPct = 0.05 } = cfg;
  const shares = Math.round(capital / limitPx);
  const target = +(limitPx * (1 + targetPct)).toFixed(2);
  const stop = +(limitPx * (1 - stopPct)).toFixed(2);
  const lim = +limitPx.toFixed(2);
  return {
    entry: {
      type: 'BUY LIMIT', shares, limitPx: lim, tif: 'Day',
      note: `Buy ${shares} sh limit $${lim.toFixed(2)} — deploys ~$${(shares * lim).toLocaleString()} only if SPCX trades down to your limit. If it never prints ≤ $${lim.toFixed(2)}, nothing fills and you keep $${capital.toLocaleString()} in cash.`,
    },
    bracket: {
      type: 'OCO (attach on fill)', shares, sellLimitPx: target, sellStopPx: stop, tif: 'Day',
      note: `On fill, attach a one-cancels-other bracket: sell-limit $${target} (target +${(targetPct * 100).toFixed(0)}%) / sell-stop $${stop} (stop −${(stopPct * 100).toFixed(0)}%). In Active Trader Pro, stage this as a conditional/contingent order tied to the buy fill.`,
    },
    residual: {
      type: 'MOC', shares,
      note: `Any shares unsold by ~3:45pm ET → Sell-on-Close (MOC/LOC); if unavailable, sell at Market by ~3:50pm.`,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add model.js test/model.test.js
git commit -m "feat(caseB): bottomFeedTicket — Fidelity buy-limit + OCO bracket + MOC"
```

---

## Task 4: Delete Day-16 logic

**Files:**
- Modify: `model.js` (remove `simulateDay16`, `buildDay16Policy`)
- Modify: `test/model.test.js` (remove the import and the three Day-16 tests)

- [ ] **Step 1: Remove the tests and import**

In `test/model.test.js`:
- Delete `  simulateDay16, buildDay16Policy,` from the import block.
- Delete the three tests whose names start: `'simulateDay16: deterministic ...'`, `'buildDay16Policy: core + rungs ...'`, `'simulateDay16 grid is scorable by evaluatePolicy'`.

- [ ] **Step 2: Remove the functions**

In `model.js`, delete the entire `simulateDay16` function (the `export function simulateDay16(cfg) { ... }` block) and the entire `buildDay16Policy` function (the `export function buildDay16Policy(...) { ... }` block). Leave `conditionalRecovery` in place.

- [ ] **Step 3: Run tests to verify nothing references the deleted code**

Run: `npm test`
Expected: PASS, with no `simulateDay16`/`buildDay16Policy` import errors. (UI references are handled in Task 9.)

Also run: `grep -rn "simulateDay16\|buildDay16Policy" model.js test/` → expect no matches.

- [ ] **Step 4: Commit**

```bash
git add model.js test/model.test.js
git commit -m "refactor: remove static Day-16 engine (superseded by 20-day model)"
```

---

## Task 5: 20-Day engine (`MEGA_IPO_POSTIPO_CURVE`, `simulatePostIPO`)

**Files:**
- Modify: `model.js`
- Test: `test/model.test.js`

- [ ] **Step 1: Write the failing tests**

Add `MEGA_IPO_POSTIPO_CURVE, simulatePostIPO` to the import block, then:

```js
test('simulatePostIPO: deterministic; grid shape (days+1)×N; grid[0] === closes', () => {
  const closes = [100, 120, 140, 160, 180];
  const a = simulatePostIPO({ closes, dailySigma: 0.03, rng: mulberry32(7), days: 20 });
  const b = simulatePostIPO({ closes, dailySigma: 0.03, rng: mulberry32(7), days: 20 });
  assert.equal(a.grid.length, 21);
  assert.equal(a.grid[0].length, closes.length);
  for (let p = 0; p < closes.length; p++) assert.equal(a.grid[0][p], closes[p]);
  assert.equal(a.grid[20][0], b.grid[20][0]); // same seed → identical
});

test('simulatePostIPO: martingale (no drift, no anchor) keeps mean ≈ start mean', () => {
  const closes = Array.from({ length: 4000 }, () => 165);
  const r = simulatePostIPO({ closes, dailySigma: 0.03, rng: mulberry32(11), days: 20 });
  const startMean = 165;
  const endMean = r.grid[20].reduce((a, b) => a + b, 0) / closes.length;
  assert.ok(Math.abs(endMean / startMean - 1) < 0.03, `endMean ${endMean} drifted from ${startMean}`);
});

test('simulatePostIPO: variance grows with horizon', () => {
  const closes = Array.from({ length: 4000 }, () => 165);
  const r = simulatePostIPO({ closes, dailySigma: 0.03, rng: mulberry32(13), days: 20 });
  const sd = (col) => { const m = col.reduce((a, b) => a + b, 0) / col.length; return Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / col.length); };
  assert.ok(sd(r.grid[20]) > sd(r.grid[5]), 'day-20 spread should exceed day-5 spread');
});

test('simulatePostIPO: Polymarket anchor pulls the terminal toward the implied level', () => {
  const closes = Array.from({ length: 4000 }, () => 165);
  // Poly curve implying ~$120/share terminal (well below the $165 start)
  const thresh = [1.0, 1.6, 2.2], above = [99, 50, 1], shares = 12.96e9; // median cap ~1.6T → 1.6e12/12.96e9 ≈ $123
  const free = simulatePostIPO({ closes, dailySigma: 0.03, rng: mulberry32(21), days: 20, anchorStrength: 0 });
  const anch = simulatePostIPO({ closes, dailySigma: 0.03, rng: mulberry32(21), days: 20, polyTerminal: { thresh, above, shares }, anchorStrength: 0.6 });
  const med = (col) => [...col].sort((a, b) => a - b)[Math.floor(col.length / 2)];
  assert.ok(med(anch.grid[20]) < med(free.grid[20]), 'anchored terminal should sit below the free-walk terminal');
});

test('MEGA_IPO_POSTIPO_CURVE is a 21-point normalized level curve starting at 1.0', () => {
  assert.equal(MEGA_IPO_POSTIPO_CURVE.length, 21);
  assert.equal(MEGA_IPO_POSTIPO_CURVE[0], 1.0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `simulatePostIPO is not defined`.

- [ ] **Step 3: Implement**

Append to `model.js` (uses the existing `sampleCap` and `gaussFrom`):

```js
// ---- 20-day post-IPO engine (Phase 2) ----------------------------------------
// Illustrative normalized post-IPO median path for large tech/space listings:
// a mild first-week fade then a gradual drift back up. Day index 0..20, level[0]=1.
// Used only as an OPTIONAL drift shape (driftWeight default 0 = martingale).
export const MEGA_IPO_POSTIPO_CURVE = [
  1.000, 0.985, 0.972, 0.965, 0.962, 0.968, 0.975, 0.982, 0.988, 0.992, 0.996,
  1.000, 1.004, 1.008, 1.011, 1.014, 1.016, 1.018, 1.020, 1.021, 1.022,
];

// Walk each Day-1 close forward `days` trading days. Per-day log change blends:
//   diffusion:  -0.5σ² + σ·Z                              (martingale GBM)
//   drift:      driftWeight · log(curve[d]/curve[d-1])     (optional historical shape)
//   anchor:     anchorStrength · (d/days) · (logT − logS)  (Polymarket terminal soft-pull)
// where logT is a per-path log terminal sampled once from the Polymarket close-cap curve.
export function simulatePostIPO(cfg) {
  const {
    closes, dailySigma, rng, days = 20,
    driftCurve = MEGA_IPO_POSTIPO_CURVE, driftWeight = 0,
    polyTerminal = null, anchorStrength = 0.3,
  } = cfg;
  const N = closes.length, g = () => gaussFrom(rng);
  const hist = (driftCurve && driftWeight > 0)
    ? Array.from({ length: days }, (_, i) => Math.log((driftCurve[i + 1] ?? 1) / (driftCurve[i] ?? 1)))
    : null;
  const grid = Array.from({ length: days + 1 }, () => new Array(N));
  for (let p = 0; p < N; p++) {
    let logS = Math.log(closes[p]);
    grid[0][p] = closes[p];
    let logT = null;
    if (polyTerminal && anchorStrength > 0) {
      const cap = sampleCap(polyTerminal.thresh, polyTerminal.above, rng); // $T
      logT = Math.log(cap * 1e12 / polyTerminal.shares);
    }
    for (let d = 1; d <= days; d++) {
      let dLog = -0.5 * dailySigma * dailySigma + g() * dailySigma;
      if (hist) dLog += driftWeight * hist[d - 1];
      if (logT != null) dLog += anchorStrength * (d / days) * (logT - logS);
      logS += dLog;
      grid[d][p] = Math.exp(logS);
    }
  }
  return { grid, days };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS for all five tests.

- [ ] **Step 5: Commit**

```bash
git add model.js test/model.test.js
git commit -m "feat(caseC): simulatePostIPO 20-day engine + mega-IPO drift curve"
```

---

## Task 6: Per-day bands (`postIpoBands`)

**Files:**
- Modify: `model.js`
- Test: `test/model.test.js`

- [ ] **Step 1: Write the failing tests**

Add `postIpoBands` to the import block, then:

```js
test('postIpoBands: ordered percentile bands per day + pBelow in [0,1]', () => {
  const closes = Array.from({ length: 3000 }, () => 165);
  const r = simulatePostIPO({ closes, dailySigma: 0.03, rng: mulberry32(9), days: 20 });
  const bands = postIpoBands(r.grid, 135);
  assert.equal(bands.length, 21);
  for (const b of bands) {
    assert.ok(b.p5 <= b.p25 && b.p25 <= b.median && b.median <= b.p75 && b.p75 <= b.p95);
    assert.ok(b.pBelow >= 0 && b.pBelow <= 1);
  }
  assert.equal(bands[0].day, 0);
  assert.equal(bands[20].day, 20);
});

test('postIpoBands: pBelow grows with horizon for a martingale started above the level', () => {
  const closes = Array.from({ length: 4000 }, () => 165);
  const r = simulatePostIPO({ closes, dailySigma: 0.03, rng: mulberry32(17), days: 20 });
  const bands = postIpoBands(r.grid, 135);
  assert.ok(bands[20].pBelow >= bands[5].pBelow, 'later-day underwater prob should not shrink');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `postIpoBands is not defined`.

- [ ] **Step 3: Implement**

Append to `model.js`:

```js
// Per-day percentile envelope + P(price < belowLevel) for the fan chart.
export function postIpoBands(grid, belowLevel = 135) {
  const days = grid.length - 1, N = grid[0].length;
  const pctAt = (col, q) => { const s = [...col].sort((a, b) => a - b); const i = (N - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
  const out = [];
  for (let d = 0; d <= days; d++) {
    const col = grid[d];
    let below = 0; for (let p = 0; p < N; p++) if (col[p] < belowLevel) below++;
    out.push({
      day: d,
      p5: pctAt(col, 0.05), p25: pctAt(col, 0.25), median: pctAt(col, 0.5),
      p75: pctAt(col, 0.75), p95: pctAt(col, 0.95), pBelow: below / N,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add model.js test/model.test.js
git commit -m "feat(caseC): postIpoBands — per-day percentile envelope + P(<\$135)"
```

---

## UI tasks (7–10) — verification protocol

There are no DOM unit tests in this repo; the UI is verified by loading it. For each UI task:

1. Start the dev server once: `python3 -m http.server 8765` (run in background) and open the preview at `http://localhost:8765/`.
2. After edits, reload the preview.
3. Verify with the preview tools: check console for errors (no red), take a snapshot to confirm the new section renders with sensible net-$ numbers, and screenshot the visual.
4. `npm test` must still pass (the model layer is unchanged by UI edits).

Read the relevant slice of `index.html` before each edit. Key anchors (line numbers approximate — re-grep before editing):
- The default position input: `id="pos" value="150000"` (~line 83).
- The `state` object: `const state = { pos:150000, ... }` (~line 194).
- The Day-1 render path calling `simulateDayOne` (~line 219).
- The execution-plan / Day-16 comparison rendering (the section referencing `simulateDay16`/`buildDay16Policy` — find via `grep -n "simulateDay16\|Day-16\|Day 16" index.html`).

---

## Task 7: Normalize to $100k + net-$ in Case A

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Change the default capital to $100,000**

- Set the position input default: `id="pos" value="100000"`.
- Set `state.pos` default to `100000`.
- Update any visible copy that says `$150,000` (e.g., the disclaimer "A $150,000 position…") to `$100,000`.

- [ ] **Step 2: Import the reporting helpers**

In the `<script type="module">` import from `./model.js`, add `netDollars, fmtNet` to the imported names.

- [ ] **Step 3: Convert Case A headline figures to net $**

In the Case A / execution-plan rendering, change the primary outcome displays (expected proceeds, median, p5/p95, baselines) so the headline number is `fmtNet(netDollars(value))` instead of a raw dollar balance or percentage. Keep a percentage only as a secondary parenthetical if already present. Example transform — where a cell currently shows `$${Math.round(stat.Eproceeds).toLocaleString()}`, render `fmtNet(netDollars(stat.Eproceeds))`.

- [ ] **Step 4: Verify**

Reload the preview. Confirm: position defaults to $100,000; Case A outcome cells show signed net dollars (e.g. `+$24,000`); no console errors. Run `npm test` (still green). Screenshot.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(report): default \$100k basis; Case A headline figures in net dollars"
```

---

## Task 8: Case B "Bottom-Feeder" section

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add imports and inputs**

- Add `simulateBottomFeed, bottomFeedTicket` to the model import.
- Add a new section (place it after the Day-1 execution plan, before the 20-day section added in Task 9) with three inputs: limit price (`id="bfLimit" value="135"`), profit target % (`id="bfTarget" value="6"`), stop % (`id="bfStop" value="5"`), and a container `<div id="bfOut"></div>` plus `<div id="bfTicket"></div>`.

- [ ] **Step 2: Render Case B**

Add a `renderBottomFeed()` function that:
- Runs a fine-resolution Day-1 simulation: call the existing `simulateDayOne` with the live inputs but `steps: 26` (reuse `thresh, above, state.shares, live.hl.mark, state.w, offer=state.offer, vol, N: state.N`). Bind it to a local `bfPaths`.
- Calls `const r = simulateBottomFeed(bfPaths, { limitPx: +bfLimit.value, capital: 100000, targetPct: +bfTarget.value/100, stopPct: +bfStop.value/100 })`.
- Renders: **P(fill)** = `(r.pFill*100).toFixed(0)%` and **P(no-fill, keep $100k)** = `(r.pNoFill*100).toFixed(0)%`; net-$ row using `fmtNet`: mean `fmtNet(r.net.mean)`, median `fmtNet(r.net.median)`, p5 `fmtNet(r.net.p5)`, p95 `fmtNet(r.net.p95)`; outcome mix (target/stop/close/no-fill percentages).
- Renders the Fidelity ticket from `bottomFeedTicket({...same cfg})` into `#bfTicket` (entry / bracket / residual rows with their `note` text).
- Wire the three inputs' `input` events to re-run `renderBottomFeed()`; call it once inside the main render after the live data is available.

- [ ] **Step 3: Verify**

Reload preview. Confirm the Bottom-Feeder section shows ~20–25% fill probability on the baked snapshot, a net-$ distribution (median near $0 because most paths don't fill), the outcome mix summing to ~100%, and a readable Fidelity ticket. No console errors. Screenshot.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(caseB): Bottom-Feeder UI — fill odds, net-\$ distribution, Fidelity ticket"
```

---

## Task 9: Replace Day-16 comparison with the 20-day fan

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Remove the Day-16 UI**

`grep -n "simulateDay16\|buildDay16Policy\|Day-16\|Day 16" index.html`. Delete the Day-16 comparison block: its markup, its render function, and any imports of `simulateDay16`/`buildDay16Policy` (these no longer exist in `model.js`, so leaving them would break the module load).

- [ ] **Step 2: Add the 20-day section markup**

Add a section with: a `<canvas id="fan20">`, a drift-weight slider (`id="driftW" min="0" max="100" value="0"`), an anchor-strength slider (`id="anchorS" min="0" max="100" value="30"`), an exit-day selector (`id="exitDay" min="1" max="20" value="20"`), and a readout container `<div id="fan20Out"></div>`. Add `simulatePostIPO, postIpoBands` to the model import.

- [ ] **Step 3: Render the fan with Chart.js**

Add `render20Day()` that:
- Derives `dailySigma` from the live realized vol (`live.vol.sessionSigma` if present, else from `BAKED_SNAPSHOT.vol.sessionSigma`).
- Runs `const sim = simulateDayOne({... steps: state.steps})` (the existing Day-1 sim already in scope) to get `sim.closes`, then `const pip = simulatePostIPO({ closes: sim.closes, dailySigma, rng: mulberry32(20260611), days: 20, driftWeight: +driftW.value/100, polyTerminal: { thresh, above, shares: state.shares }, anchorStrength: +anchorS.value/100 })`.
- `const bands = postIpoBands(pip.grid, 135)`.
- Draws a Chart.js line chart with x = day 0..20 and these datasets: median (solid), p25/p75 (band fill), p5/p95 (lighter band), and a **flat dashed line at y=135 across all days** (the entry baseline). Label the $135 line prominently.
- Readout `#fan20Out`: for the selected `exitDay`, show Case C **net $** at the median/p5/p95 (`fmtNet(netDollars(740.74 * bands[exitDay].<pct>))` where 740.74 = 100000/135) and **P(underwater) = `(bands[exitDay].pBelow*100).toFixed(0)%`**.
- Wire the three controls to re-run `render20Day()`.

Note: reuse the existing Chart.js instance pattern in `index.html` (destroy/recreate or `.update()` like the other charts) to avoid leaking canvases on slider moves.

- [ ] **Step 4: Verify**

Reload preview. Confirm: a 20-day fan renders with a visible flat $135 dashed baseline, median path, and percentile bands widening over time; moving the anchor slider visibly pulls the late-day bands; the exit-day readout shows Case C net-$ and an underwater probability rising from ~20% (day 1) toward ~25% (day 20) on the baked snapshot. No console errors. Screenshot.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(caseC): 20-day probabilistic fan — bands, median, \$135 baseline, exit-day net-\$"
```

---

## Task 10: Three-Strategy Scorecard

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the scorecard markup**

Add a section near the top of the results (after the verdict) with a `<table id="scorecard">` placeholder and a container the render function fills.

- [ ] **Step 2: Render A / B / C side-by-side in net $**

Add `renderScorecard(caseA, caseB, caseC)` that builds a 3-column table. Each value uses `fmtNet`. Source the figures from the already-computed results in this render pass:
- **Case A** (allocation, Day-1 exit): from the execution-plan evaluation — mean/median/p5/p95 as `fmtNet(netDollars(stat.X))`; P(loss) = `pNetLoss`; signature stat = `pSubBasisSale`.
- **Case B** (bottom-feed): from `simulateBottomFeed` result `r` — `fmtNet(r.net.mean/median/p5/p95)` (already net of capital); P(loss) = fraction of `r.nets < 0`; signature = `pFill` / `pNoFill`.
- **Case C** (hold to selected exit day): from `bands[exitDay]` — `fmtNet(netDollars(740.74 * band.median))` etc.; P(loss) = `band.pBelow`; signature = P(underwater @ exit day) = `band.pBelow`.

Call `renderScorecard(...)` at the end of the main render, after Cases A/B/C have computed.

- [ ] **Step 3: Verify**

Reload preview. Confirm a three-column scorecard renders, every figure is a signed net-dollar string (no raw percentages as the primary cell; percentages only in the P(loss)/signature rows), and the numbers are internally consistent with the individual sections. No console errors. Screenshot the full page.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(report): three-strategy scorecard (A/B/C) in net dollars"
```

---

## Task 11: README + blending-weights writeup

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

- Update the title/intro to mention the three strategies (allocation Day-1, bottom-feeder Day-1, allocation 20-day hold) and the $100k net-$ standard.
- Replace the "Execution Plan (Day-1)" Day-16 references with the 20-day engine.
- Add a **Blending weights** subsection stating: Day-1 close center `center = w·HL_mark + (1−w)·Poly_median_per_share`; the 20-day path = GBM(dailyσ) + `driftWeight`·historical-shape (default 0) + `anchorStrength`·(d/20)·(logPolyTerminal − logS) (default 0.3); HL governs level/early path, the historical curve adds optional shape, Polymarket governs the terminal spread.
- Update the `## Layout` bullets (note `model.js` now exports the bottom-feeder + 20-day engine; Day-16 removed).

- [ ] **Step 2: Verify and commit**

Run `npm test` (green). Then:

```bash
git add README.md
git commit -m "docs: README — three strategies, \$100k net-\$ standard, blending-weights writeup"
```

---

## Final verification

- [ ] `npm test` — all tests green, no Day-16 references remain (`grep -rn "Day16\|simulateDay16\|buildDay16Policy" model.js test/ index.html` → empty).
- [ ] Load the preview end-to-end: verdict + scorecard + Case A (net $) + Case B bottom-feeder + 20-day fan with $135 baseline all render without console errors.
- [ ] Spot-check the three signature numbers against the baked snapshot: Case B P(fill) ≈ 24%, Case C P(underwater @ day 20) ≈ 25%.
- [ ] Offer the PR via `superpowers:finishing-a-development-branch`.
