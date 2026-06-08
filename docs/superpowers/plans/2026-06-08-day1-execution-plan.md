# Day-1 Execution Plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive "Execution Plan" tab to the SpaceX Day-1 model that turns the existing 10,000-path price grid into scored sell-scenarios with copy-pasteable Fidelity order tickets, plus a quantitative Day-16 ("clean", no flip-penalty) comparison.

**Architecture:** All scoring is new **pure functions in `model.js`** (unit-tested via Node's built-in runner, like the rest of the file). `index.html` gains one new "Execution Plan" section that calls these functions inside the existing `render()` pipeline and draws the ladder, ticket table, checkpoint timeline, and comparison. No new dependencies; no server; no change to the existing price model or charts.

**Tech Stack:** Vanilla ES modules, Node 25 built-in test runner (`node --test`), Chart.js (already loaded in `index.html`). DOM built with `createElement`/`textContent` (no `innerHTML`).

**Spec:** `docs/superpowers/specs/2026-06-08-day1-execution-plan-design.md`

---

## File Structure

- **Modify `model.js`** — append pure functions: `evaluatePolicy`, `sellAllAt`, `conditionalRecovery`, `buildScenario`, `ticketsFromPolicy`, `simulateDay16`, `buildDay16Policy`. (Imports `gaussFrom` which already exists in this file.)
- **Modify `test/model.test.js`** — append a test block per new function.
- **Modify `index.html`** — add the "Execution Plan" `<section>`, extend the module imports, extend `state`, add `renderExecutionPlan()` + a small comparison chart, and wire scenario/risk controls into the existing event-listener block.

Each task is independently committable. Tasks 1–5 are pure-logic + tests. Task 6 is the UI integration. Task 7 is final verification.

---

### Task 1: `evaluatePolicy` + `sellAllAt` (the scoring engine)

**Files:**
- Modify: `model.js` (append)
- Test: `test/model.test.js` (append)

`evaluatePolicy` walks each path's open→close prices and simulates fills: upside limit tranches (limits filled before stop within a step — the documented tie-break), a whole-remaining-position protective stop whose level varies by session fraction, and a forced close-out of any residual at the close price. It is **grid-length-agnostic** (derives `steps` from `grid.length-1`) so Task 5 can reuse it on the Day-16 grid.

- [ ] **Step 1: Write the failing tests**

Append to `test/model.test.js` (also add `evaluatePolicy, sellAllAt` to the existing import block at the top of the file):

```js
test('evaluatePolicy: pure limit ladder fills at rungs, no stop', () => {
  // 2 paths, 3 time-points. Path0 rises through both rungs; Path1 never reaches rung2.
  const grid = [
    [100, 100],   // k=0 (open)
    [110, 105],   // k=1
    [120, 104],   // k=2 (close)
  ];
  const policy = { shares: 100, entry: 100,
    tranches: [ { frac: 0.5, limitPx: 105 }, { frac: 0.5, limitPx: 115 } ],
    stopSchedule: [] };
  const r = evaluatePolicy({ grid, entry: 100 }, policy);
  // Path0: 50@105 (k=1) + 50@115 (k=2) = 5250+5750 = 11000
  // Path1: 50@105 (k=1) + residual 50@close 104 = 5250+5200 = 10450
  assert.equal(r.Eproceeds, (11000 + 10450) / 2);     // 10725
  assert.equal(r.pSubBasisSale, 0);                   // entry 100; no sale below 100
  assert.equal(r.mix.closePct, 50 / 200);             // only Path1's residual 50 of 200 total shares
});

test('evaluatePolicy: stop sweeps remaining position below entry; counts sub-basis', () => {
  const grid = [
    [100, 100],
    [ 96,  98],   // k=1: Path0 hits stop 97
    [102, 110],   // k=2 close
  ];
  const policy = { shares: 100, entry: 100,
    tranches: [ { frac: 0.5, limitPx: 130 } ],         // never fills
    stopSchedule: [ { from: 0.0, stopPx: 97 } ] };
  const r = evaluatePolicy({ grid, entry: 100 }, policy);
  // Path0: stop fires k=1, all 100 @97 = 9700; 100 sub-basis shares.
  // Path1: never <=97, never >=130 → residual 100 @ close 110 = 11000; 0 sub-basis.
  assert.equal(r.Eproceeds, (9700 + 11000) / 2);       // 10350
  assert.equal(r.pSubBasisSale, 0.5);
  assert.equal(r.eSharesSubBasis, 50);                 // (100 + 0)/2
  assert.equal(r.pNetLoss, 0.5);                       // basis 10000; Path0 9700 < 10000
});

test('evaluatePolicy: within-step tie-break fills limit before stop', () => {
  // Single path, single step after open: price 120 crosses limit 110 up; stop 105 irrelevant (120 > 105).
  const grid = [ [100], [120] ];
  const policy = { shares: 100, entry: 100,
    tranches: [ { frac: 1.0, limitPx: 110 } ],
    stopSchedule: [ { from: 0.0, stopPx: 105 } ] };
  const r = evaluatePolicy({ grid, entry: 100 }, policy);
  assert.equal(r.Eproceeds, 100 * 110);               // all filled at the limit, not the stop
  assert.equal(r.mix.upsidePct, 1);
});

test('sellAllAt returns mean column price × shares', () => {
  const paths = { grid: [ [100, 200], [0, 0] ], entry: 100 };
  assert.equal(sellAllAt(paths, 0, 10).Eproceeds, 1500); // mean(100,200)=150 × 10
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/spacex-ipo-model && npm test`
Expected: FAIL — `evaluatePolicy is not defined` / `sellAllAt is not defined`.

- [ ] **Step 3: Write the implementation**

Append to `model.js`:

```js
// ---- Execution layer (pure, tested) -------------------------------------

// Score one execution policy against a simulated open→close price grid.
//   paths : { grid: number[steps+1][N], entry }     (grid-length-agnostic)
//   policy: { shares, entry, tranches:[{frac,limitPx}], stopSchedule:[{from,stopPx}] }
// Tie-break: within a step, upside limits fill BEFORE the protective stop.
// The stop covers the whole remaining position. Residual sells at the close price.
export function evaluatePolicy(paths, policy) {
  const { grid } = paths;
  const steps = grid.length - 1;
  const N = grid[0].length;
  const { shares, entry, tranches, stopSchedule } = policy;
  const basis = shares * entry;
  const proceeds = new Array(N);
  let subCount = 0, subSharesSum = 0, netLoss = 0, upSum = 0, stopSum = 0, closeSum = 0;

  const activeStop = (frac) => {
    let s = null;
    for (const e of stopSchedule) if (e.from <= frac + 1e-9) s = e.stopPx;
    return s;
  };

  for (let p = 0; p < N; p++) {
    let left = shares, value = 0, subShares = 0;
    const filled = new Array(tranches.length).fill(false);
    for (let k = 0; k <= steps && left > 1e-9; k++) {
      const price = grid[k][p], frac = k / steps;
      for (let t = 0; t < tranches.length; t++) {            // A) upside limits first
        if (filled[t] || price < tranches[t].limitPx) continue;
        const qty = Math.min(left, shares * tranches[t].frac);
        value += qty * tranches[t].limitPx; left -= qty; upSum += qty; filled[t] = true;
      }
      const stop = activeStop(frac);                          // B) protective stop on remainder
      if (stop != null && left > 1e-9 && price <= stop) {
        value += left * stop; if (stop < entry) subShares += left; stopSum += left; left = 0;
      }
    }
    if (left > 1e-9) {                                        // C) forced close-out at close
      const close = grid[steps][p];
      value += left * close; if (close < entry) subShares += left; closeSum += left; left = 0;
    }
    proceeds[p] = value;
    if (subShares > 1e-9) { subCount++; subSharesSum += subShares; }
    if (value < basis - 1e-6) netLoss++;
  }

  const sorted = [...proceeds].sort((a, b) => a - b);
  const pct = (q) => { const i = (N - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
  const meanP = proceeds.reduce((a, b) => a + b, 0) / N;
  const tot = N * shares;
  return {
    Eproceeds: meanP, medianProceeds: pct(0.5), p5: pct(0.05), p95: pct(0.95),
    pNetLoss: netLoss / N, pSubBasisSale: subCount / N, eSharesSubBasis: subSharesSum / N,
    avgSalePx: meanP / shares,
    mix: { upsidePct: upSum / tot, stopPct: stopSum / tot, closePct: closeSum / tot },
  };
}

// Baseline: sell the entire position at one grid column (e.g. open or close).
export function sellAllAt(paths, stepIndex, shares) {
  const col = paths.grid[stepIndex];
  const m = col.reduce((a, b) => a + b, 0) / col.length;
  return { Eproceeds: m * shares, avgSalePx: m };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Desktop/spacex-ipo-model && npm test`
Expected: PASS (all four new tests green; existing tests unaffected).

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/spacex-ipo-model
git add model.js test/model.test.js
git commit -m "feat: evaluatePolicy scoring engine + sellAllAt baseline"
```

---

### Task 2: `conditionalRecovery` (the "don't shake me out" stat)

**Files:**
- Modify: `model.js` (append)
- Test: `test/model.test.js` (append)

Computes, for early steps, `P(close > entry | price < entry at step k)` — the model-grounded reason the plan gives the position room early.

- [ ] **Step 1: Write the failing test**

Append to `test/model.test.js` (add `conditionalRecovery` to the import block):

```js
test('conditionalRecovery: P(green close | early dip) per step', () => {
  // 4 paths, 3 time-points (steps=2). entry 100. Look at k=1.
  const grid = [
    [100, 100, 100, 100], // open
    [ 95,  98, 101,  90], // k=1: paths 0,1,3 dip below 100; path2 does not
    [110,  97, 105,  90], // close: among dippers, 0 recovers (>100), 1 no, 3 no
  ];
  const out = conditionalRecovery(grid, 100, [1]);
  assert.equal(out.length, 1);
  assert.equal(out[0].k, 1);
  assert.equal(out[0].dips, 3);
  assert.equal(out[0].p, 1 / 3);   // only path0 closes green
});

test('conditionalRecovery: null when no dips at that step', () => {
  const grid = [ [100, 100], [101, 102], [103, 104] ];
  assert.equal(conditionalRecovery(grid, 100, [1])[0].p, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Desktop/spacex-ipo-model && npm test`
Expected: FAIL — `conditionalRecovery is not defined`.

- [ ] **Step 3: Write the implementation**

Append to `model.js`:

```js
// For each early step k, P(close > entry | price at step k < entry).
export function conditionalRecovery(grid, entry, ks = [1, 2, 3]) {
  const steps = grid.length - 1, N = grid[0].length, close = grid[steps];
  return ks.filter(k => k >= 0 && k <= steps).map(k => {
    let dips = 0, recover = 0;
    for (let p = 0; p < N; p++) if (grid[k][p] < entry) { dips++; if (close[p] > entry) recover++; }
    return { k, frac: k / steps, dips, p: dips ? recover / dips : null };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Desktop/spacex-ipo-model && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/spacex-ipo-model
git add model.js test/model.test.js
git commit -m "feat: conditionalRecovery (P green close given early dip)"
```

---

### Task 3: `buildScenario` (3 time-phased presets + risk slider)

**Files:**
- Modify: `model.js` (append)
- Test: `test/model.test.js` (append)

Returns a `policy` for `'protect' | 'balanced' | 'ride'`. `riskLevel` 0–100 modulates rung heights and stop tightness around a neutral 50 (factor 1.0).

- [ ] **Step 1: Write the failing tests**

Append to `test/model.test.js` (add `buildScenario` to the import block):

```js
test('buildScenario: balanced at neutral risk matches base table', () => {
  const p = buildScenario('balanced', 50, { entry: 135, shares: 1111 });
  assert.equal(p.name, 'balanced');
  assert.deepEqual(p.tranches.map(t => t.frac), [0.25, 0.25, 0.25, 0.15]);
  assert.equal(p.tranches[0].limitPx, +(135 * 1.04).toFixed(2)); // 140.40
  assert.equal(p.stopSchedule[0].stopPx, +(135 * 0.94).toFixed(2)); // -6% => 126.90
  // residual fraction = 1 - sum(splits) = 0.10
  const laddered = p.tranches.reduce((a, t) => a + t.frac, 0);
  assert.ok(Math.abs(1 - laddered - 0.10) < 1e-9);
});

test('buildScenario: higher riskLevel loosens stops and raises rungs', () => {
  const lo = buildScenario('balanced', 0,   { entry: 135, shares: 1111 });
  const hi = buildScenario('balanced', 100, { entry: 135, shares: 1111 });
  assert.ok(hi.tranches[0].limitPx > lo.tranches[0].limitPx);       // rungs higher
  assert.ok(hi.stopSchedule[0].stopPx < lo.stopSchedule[0].stopPx); // stop further below entry
});

test('buildScenario: unknown name throws', () => {
  assert.throws(() => buildScenario('nope', 50, { entry: 135, shares: 1111 }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/spacex-ipo-model && npm test`
Expected: FAIL — `buildScenario is not defined`.

- [ ] **Step 3: Write the implementation**

Append to `model.js`:

```js
const SCENARIO_DEFS = {
  protect:  { rungs: [0.03, 0.06, 0.10],        splits: [0.40, 0.30, 0.20],
              stops: [{ from: 0.25, pct: -0.04 }, { from: 0.60, pct: -0.02 }, { from: 0.85, pct: -0.01 }] },
  balanced: { rungs: [0.04, 0.08, 0.12, 0.18],  splits: [0.25, 0.25, 0.25, 0.15],
              stops: [{ from: 0.40, pct: -0.06 }, { from: 0.70, pct: -0.04 }, { from: 0.90, pct: -0.02 }] },
  ride:     { rungs: [0.10, 0.20, 0.30],        splits: [0.25, 0.25, 0.25],
              stops: [{ from: 0.15, pct: -0.12 }, { from: 0.80, pct: -0.03 }] },
};

// riskLevel 0..100 → modulation factor 0.75..1.25 (50 = neutral 1.0).
export function buildScenario(name, riskLevel, ctx) {
  const def = SCENARIO_DEFS[name];
  if (!def) throw new Error(`unknown scenario: ${name}`);
  const { entry, shares } = ctx;
  const f = 1 + (riskLevel - 50) / 100 * 0.5;
  return {
    name, entry, shares,
    tranches: def.rungs.map((r, i) => ({ frac: def.splits[i], limitPx: +(entry * (1 + r * f)).toFixed(2) })),
    stopSchedule: def.stops.map(s => ({ from: s.from, stopPx: +(entry * (1 + s.pct * f)).toFixed(2) })),
  };
}
export const SCENARIO_NAMES = Object.keys(SCENARIO_DEFS);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Desktop/spacex-ipo-model && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/spacex-ipo-model
git add model.js test/model.test.js
git commit -m "feat: buildScenario presets (protect/balanced/ride) + risk modulation"
```

---

### Task 4: `ticketsFromPolicy` (Fidelity order tickets + checkpoints)

**Files:**
- Modify: `model.js` (append)
- Test: `test/model.test.js` (append)

Turns a `policy` into OCO ladder rows, an MOC residual row, and the manual stop-escalation checkpoints with wall-clock times.

- [ ] **Step 1: Write the failing tests**

Append to `test/model.test.js` (add `ticketsFromPolicy` to the import block):

```js
test('ticketsFromPolicy: OCO ladder + residual + checkpoints', () => {
  const policy = buildScenario('balanced', 50, { entry: 135, shares: 1111 });
  const t = ticketsFromPolicy(policy);
  assert.equal(t.ladder.length, 4);                       // one OCO per tranche
  assert.equal(t.ladder[0].type, 'OCO');
  assert.equal(t.ladder[0].tif, 'Day');
  assert.equal(t.ladder[0].limitPx, policy.tranches[0].limitPx);
  assert.equal(t.ladder[0].stopPx, policy.stopSchedule[0].stopPx); // first scheduled stop
  // share allocation: laddered shares + residual ≈ total position (rounding)
  const laddered = t.ladder.reduce((a, r) => a + r.shares, 0);
  assert.ok(Math.abs(laddered + t.residual.shares - 1111) <= t.ladder.length + 1);
  assert.equal(t.residual.type, 'MOC');
  assert.equal(t.checkpoints.length, policy.stopSchedule.length);
  assert.match(t.checkpoints[0].clock, /ET$/);            // wall-clock formatted
});

test('ticketsFromPolicy: clock maps session fraction to ET window', () => {
  const policy = buildScenario('balanced', 50, { entry: 135, shares: 1111 });
  const t = ticketsFromPolicy(policy, { openMin: 600, closeMin: 960 }); // 10:00–16:00
  assert.equal(t.flatBy, '4:00pm ET');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/spacex-ipo-model && npm test`
Expected: FAIL — `ticketsFromPolicy is not defined`.

- [ ] **Step 3: Write the implementation**

Append to `model.js`:

```js
// Render a policy as Fidelity-executable tickets. Each upside tranche is an OCO
// (sell-limit-up / sell-stop-down) on its shares; equal stop levels across tranches
// behave as one whole-position stop (matches evaluatePolicy). Residual = MOC/LOC.
export function ticketsFromPolicy(policy, opts = {}) {
  const { shares, tranches, stopSchedule } = policy;
  const openMin = opts.openMin ?? 600;   // 10:00 ET (IPOs often open late; adjust to the real open)
  const closeMin = opts.closeMin ?? 960; // 16:00 ET
  const clock = (frac) => {
    const m = Math.round(openMin + frac * (closeMin - openMin));
    const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
    const ap = h < 12 ? 'am' : 'pm', hh = ((h + 11) % 12) + 1;
    return `${hh}:${mm}${ap} ET`;
  };
  const r = (n) => Math.round(n);
  const firstStop = stopSchedule[0] || null;
  const ladder = tranches.map((t, i) => ({
    tranche: i + 1, shares: r(shares * t.frac),
    limitPx: t.limitPx, stopPx: firstStop ? firstStop.stopPx : null,
    type: 'OCO', tif: 'Day',
  }));
  const laddered = tranches.reduce((a, t) => a + t.frac, 0);
  const residualShares = r(shares * (1 - laddered));
  const checkpoints = stopSchedule.map((s, i) => ({
    atFrac: s.from, clock: clock(s.from), stopPx: s.stopPx,
    action: i === 0
      ? `Add a protective Sell Stop at $${s.stopPx} on all unsold shares — place it once SPCX has a printed price (new IPOs reject stops until a quote exists).`
      : `Cancel the prior stop and re-enter it at $${s.stopPx} on all unsold shares.`,
  }));
  return {
    ladder,
    residual: {
      shares: residualShares, type: 'MOC',
      note: `Sell-on-Close (MOC/LOC) for any unsold shares; enter before the ~3:45pm ET cutoff. If your account/security can't place on-close orders, sell at Market by ~3:50pm. The active stop also covers this residual until then.`,
    },
    checkpoints,
    flatBy: clock(1),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Desktop/spacex-ipo-model && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/spacex-ipo-model
git add model.js test/model.test.js
git commit -m "feat: ticketsFromPolicy (OCO ladder, MOC residual, escalation checkpoints)"
```

---

### Task 5: `simulateDay16` + `buildDay16Policy` (clean-exit comparison)

**Files:**
- Modify: `model.js` (append)
- Test: `test/model.test.js` (append)

Evolves each Day-1 close forward ~11 trading days (drift 0, with overnight-gap variance), then builds a 3-day exit grid that `evaluatePolicy` (Task 1) scores directly.

- [ ] **Step 1: Write the failing tests**

Append to `test/model.test.js` (add `simulateDay16, buildDay16Policy` to the import block; `mulberry32` is already imported):

```js
test('simulateDay16: deterministic under seed; grid shape; mean ≈ start (drift 0)', () => {
  const closes = Array.from({ length: 4000 }, () => 150);
  const a = simulateDay16({ closes, dailySigma: 0.03, rng: mulberry32(7) });
  const b = simulateDay16({ closes, dailySigma: 0.03, rng: mulberry32(7) });
  assert.deepEqual(a.grid[0].slice(0, 5), b.grid[0].slice(0, 5)); // reproducible
  assert.equal(a.grid.length, 4);              // exitDays(3)+1 points
  assert.equal(a.grid[0].length, 4000);
  assert.ok(Math.abs(a.meanLevel16 / 150 - 1) < 0.05); // drift-0 mean within 5% of start
});

test('buildDay16Policy: two rungs + a stop, residual to close', () => {
  const p = buildDay16Policy(135, 1111);
  assert.equal(p.tranches.length, 2);
  assert.ok(p.tranches[0].limitPx > 135 && p.tranches[1].limitPx > p.tranches[0].limitPx);
  assert.ok(p.stopSchedule.length >= 1);
  const laddered = p.tranches.reduce((a, t) => a + t.frac, 0);
  assert.ok(laddered < 1); // leaves a residual for the day-18 close
});

test('simulateDay16 grid is scorable by evaluatePolicy', () => {
  const closes = Array.from({ length: 2000 }, (_, i) => 140 + (i % 20)); // spread
  const d16 = simulateDay16({ closes, dailySigma: 0.03, rng: mulberry32(3) });
  const r = evaluatePolicy({ grid: d16.grid, entry: 135 }, buildDay16Policy(135, 1111));
  assert.ok(r.Eproceeds > 0);
  assert.ok(r.pSubBasisSale >= 0 && r.pSubBasisSale <= 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/spacex-ipo-model && npm test`
Expected: FAIL — `simulateDay16 is not defined`.

- [ ] **Step 3: Write the implementation**

Append to `model.js`:

```js
// Day-16 "clean" exit: drift each Day-1 close forward holdDays trading days (drift 0,
// with an overnight-gap term), then build an exitDays-day grid for a staged exit.
export function simulateDay16(cfg) {
  const { closes, dailySigma, rng, holdDays = 11, exitDays = 3, gapMult = 0.5 } = cfg;
  const N = closes.length, g = () => gaussFrom(rng);
  const step = (s) => s * Math.exp(-0.5 * dailySigma * dailySigma + g() * dailySigma + g() * dailySigma * gapMult);
  const level16 = new Array(N);
  for (let p = 0; p < N; p++) { let s = closes[p]; for (let d = 0; d < holdDays; d++) s = step(s); level16[p] = s; }
  const pts = exitDays + 1;
  const grid = Array.from({ length: pts }, () => new Array(N));
  for (let p = 0; p < N; p++) { let s = level16[p]; grid[0][p] = s; for (let k = 1; k < pts; k++) { s = step(s); grid[k][p] = s; } }
  return { grid, level16, meanLevel16: level16.reduce((a, b) => a + b, 0) / N };
}

// A simple, sensible day-16 staged-exit policy (two limit rungs + ratcheting stop).
export function buildDay16Policy(entry, shares) {
  return {
    entry, shares,
    tranches: [ { frac: 0.34, limitPx: +(entry * 1.05).toFixed(2) }, { frac: 0.33, limitPx: +(entry * 1.10).toFixed(2) } ],
    stopSchedule: [ { from: 0.0, stopPx: +(entry * 0.94).toFixed(2) }, { from: 0.66, stopPx: +(entry * 0.98).toFixed(2) } ],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Desktop/spacex-ipo-model && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/spacex-ipo-model
git add model.js test/model.test.js
git commit -m "feat: simulateDay16 multi-day clean-exit + buildDay16Policy"
```

---

### Task 6: "Execution Plan" UI section in `index.html`

**Files:**
- Modify: `index.html` (imports, `state`, new `<section>`, `renderExecutionPlan()`, control wiring)

This is an integration task (no unit test); verified by serving locally and confirming the section renders and reacts. The existing model tests must remain green. **All dynamic DOM is built with `createElement`/`textContent` — no `innerHTML`.**

- [ ] **Step 1: Extend the module imports**

In `index.html`, find the import from `./model.js` (around line 144–145) and add the new names. Replace:

```js
import { mulberry32, parsePolymarketCurve, curveArrays, parseHyperliquid,
         realizedVolFromCandles, medianCapT, disagreement, simulateDayOne } from './model.js';
```

with:

```js
import { mulberry32, parsePolymarketCurve, curveArrays, parseHyperliquid,
         realizedVolFromCandles, medianCapT, disagreement, simulateDayOne,
         evaluatePolicy, sellAllAt, conditionalRecovery, buildScenario, SCENARIO_NAMES,
         ticketsFromPolicy, simulateDay16, buildDay16Policy } from './model.js';
```

- [ ] **Step 2: Extend `state` and default position to $150,000**

Find (around line 157):

```js
const state = { pos:100000, offer:135, shares:12.96e9, w:0.5, vol:BAKED_SNAPSHOT.vol.sliderVal, N:10000, steps:8 };
```

Replace with:

```js
const state = { pos:150000, offer:135, shares:12.96e9, w:0.5, vol:BAKED_SNAPSHOT.vol.sliderVal, N:10000, steps:8,
                scenario:'balanced', risk:50 };
```

Also update the position input default. Find:

```html
<input type="number" id="pos" value="100000" min="1000" step="1000">
```

change `value="100000"` to `value="150000"`, and change the `posLbl` default:

```html
<label>Position size <span class="val" id="posLbl">$150,000</span></label>
```

- [ ] **Step 3: Add the Execution Plan section markup**

In `index.html`, search the HTML for the card containing `id="survChart"`, and immediately after that card's closing `</div>` (and before the "Honest read." caveat block), insert:

```html
<section class="card" id="execSection" style="margin-top:16px">
  <div class="secrow"><h2>Execution Plan — Day 1 (flat by close)</h2><span class="ln"></span></div>
  <p class="hint">A scaled sell plan for your $135 allocation, scored against all 10,000 simulated paths.
    Pick a posture; the levels, tickets, and odds re-compute live. Selling within Fidelity's first
    <b>15 calendar days</b> is a "flip" (6-month IPO-access block, first offense) — see the Day-16 comparison below.</p>

  <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0">
    <div id="scenBtns" style="display:flex;gap:8px"></div>
    <div class="ctl" style="min-width:240px">
      <label>Protection aggressiveness <span class="val" id="riskLbl">50</span></label>
      <input type="range" id="risk" min="0" max="100" value="50">
      <div class="hint">Left = tighter stops / lower rungs (protect). Right = looser stops / higher rungs (ride upside).</div>
    </div>
  </div>

  <div id="recoveryNote" class="verdict" style="margin:8px 0"></div>
  <div class="metrics" id="execMetrics"></div>

  <h3 style="margin-top:14px">Fidelity order tickets <span class="hint">(Active Trader Pro · OCO brackets · TIF Day)</span></h3>
  <div id="ticketTable"></div>
  <h3 style="margin-top:14px">Intraday checkpoints</h3>
  <div id="checkpointList" class="hint"></div>

  <h3 style="margin-top:16px">Day-1 (flip) vs Day-16 (clean) — what the IPO-access penalty costs</h3>
  <div id="compareNote" class="verdict" style="margin:8px 0"></div>
  <div class="cbox short"><canvas id="compareChart"></canvas></div>
</section>
```

- [ ] **Step 4: Add `renderExecutionPlan()` and call it from `render()`**

In `index.html`, at the very end of the `render()` function body (right after the `drawSurv(thresh,above);` line), add:

```js
  renderExecutionPlan(sim);
```

Then add these definitions immediately after the `render()` function closes (before `updateLiveStrip`). Note the `el()` helper — every dynamic node is created with `createElement`/`textContent`, no `innerHTML`:

```js
let compareChartRef = null;
function fmtMoney(x){ return '$'+Math.round(x).toLocaleString(); }
function el(tag, props={}, ...kids){ const e=document.createElement(tag); Object.assign(e, props); for (const k of kids) e.append(k); return e; }
function txt(s){ return document.createTextNode(s); }

function renderExecutionPlan(sim){
  const entry = sim.entry;
  const shares = Math.round(state.pos / entry);
  const paths = { grid: sim.grid, entry };
  const ctx = { entry, shares };

  // scenario buttons (build once)
  const bw = document.getElementById('scenBtns');
  if (!bw.dataset.built){
    const labels = { protect:'Protect First', balanced:'Balanced', ride:'Ride the Upside' };
    SCENARIO_NAMES.forEach(n=>{
      const b = el('button', { className:'btn', textContent:labels[n] });
      b.dataset.scen = n;
      b.addEventListener('click', ()=>{ state.scenario=n; render(); });
      bw.appendChild(b);
    });
    bw.dataset.built = '1';
  }
  [...bw.children].forEach(b=> b.style.outline = (b.dataset.scen===state.scenario) ? '2px solid #b58bff' : 'none');

  // score the chosen scenario + the two baselines
  const policy = buildScenario(state.scenario, state.risk, ctx);
  const r = evaluatePolicy(paths, policy);
  const atOpen = sellAllAt(paths, 0, shares);
  const toClose = sellAllAt(paths, state.steps, shares);
  const basis = shares * entry;

  // conditional-recovery sentence (first hour)
  const rec = conditionalRecovery(sim.grid, entry, [1]);
  const rn = document.getElementById('recoveryNote'); rn.textContent='';
  if (rec[0] && rec[0].p != null){
    rn.append(
      txt(`When SPCX dips below $${entry} early in the session, the model still closes green `),
      el('b', { textContent: (rec[0].p*100).toFixed(0)+'% of the time' }),
      txt(` — which is why this plan gives the position room early and only tightens the stop into the close.`));
  }

  // metric cards
  const cards = [
    {k:'Expected proceeds', v:fmtMoney(r.Eproceeds), c:r.Eproceeds>=basis?'pos':'neg', s:`${fmtPct(r.Eproceeds/basis-1)} vs $${basis.toLocaleString()} basis · avg $${r.avgSalePx.toFixed(2)}/sh`},
    {k:'Middle-90% proceeds', v:`${fmtMoney(r.p5)}–${fmtMoney(r.p95)}`, c:'neu', s:`median ${fmtMoney(r.medianProceeds)}`},
    {k:'Chance of a net loss', v:(r.pNetLoss*100).toFixed(0)+'%', c:r.pNetLoss>0.15?'neg':'pos', s:`proceeds below your $${basis.toLocaleString()} basis`},
    {k:`Chance of a sub-$${entry} sale`, v:(r.pSubBasisSale*100).toFixed(0)+'%', c:r.pSubBasisSale>0.2?'neg':'neu', s:`≈ ${Math.round(r.eSharesSubBasis)} sh on average`},
    {k:'Sell mix', v:`${(r.mix.upsidePct*100).toFixed(0)}% up`, c:'neu', s:`${(r.mix.stopPct*100).toFixed(0)}% stop · ${(r.mix.closePct*100).toFixed(0)}% close`},
    {k:'vs sell-all-at-open', v:fmtMoney(r.Eproceeds-atOpen.Eproceeds), c:r.Eproceeds>=atOpen.Eproceeds?'pos':'neg', s:`open avg $${atOpen.avgSalePx.toFixed(2)} · hold-to-close ${fmtMoney(toClose.Eproceeds)}`},
  ];
  const M = document.getElementById('execMetrics'); M.textContent='';
  cards.forEach(m=> M.append(el('div', { className:'metric' },
    el('div', { className:'k', textContent:m.k }),
    el('div', { className:'v '+m.c, textContent:m.v }),
    el('div', { className:'s', textContent:m.s }))));

  // ticket table
  const t = ticketsFromPolicy(policy);
  const tt = document.getElementById('ticketTable'); tt.textContent='';
  const headRow = el('tr', { style:'text-align:left;color:#9a8fc0' });
  ['#','Order','Shares','Sell limit','Sell stop','TIF'].forEach(h=> headRow.append(el('th', { textContent:h })));
  const tbody = el('tbody');
  t.ladder.forEach(L=> tbody.append(el('tr', { style:'border-top:1px solid #2a2150' },
    el('td', { textContent:String(L.tranche) }),
    el('td', { textContent:L.type }),
    el('td', { textContent:L.shares.toLocaleString() }),
    el('td', { textContent:'$'+L.limitPx }),
    el('td', { textContent:L.stopPx!=null ? '$'+L.stopPx : '—' }),
    el('td', { textContent:L.tif }))));
  tbody.append(el('tr', { style:'border-top:1px solid #2a2150' },
    el('td', { textContent:'R' }),
    el('td', { textContent:t.residual.type }),
    el('td', { textContent:t.residual.shares.toLocaleString() }),
    el('td', { colSpan:3, textContent:t.residual.note })));
  const table = el('table', { style:'width:100%;border-collapse:collapse;font-size:13px' },
    el('thead', {}, headRow), tbody);
  const tableNote = el('div', { className:'hint', style:'margin-top:6px' },
    txt('Flat by '), el('b', { textContent:t.flatBy }),
    txt('. Each numbered row is one OCO bracket in Active Trader Pro: the limit takes profit at the rung, the stop protects the same shares — whichever fills cancels the other.'));
  tt.append(table, tableNote);

  // checkpoints
  const cl = document.getElementById('checkpointList'); cl.textContent='';
  const ul = el('ul', { style:'margin:0;padding-left:18px' });
  t.checkpoints.forEach(c=> ul.append(el('li', {}, el('b', { textContent:c.clock }), txt(' — '+c.action))));
  ul.append(el('li', {}, el('b', { textContent:t.flatBy }), txt(' — confirm the position is fully closed.')));
  cl.append(ul);

  // Day-16 comparison
  const sessionSigma = 0.02 + 0.18 * (state.vol / 100);
  const d16 = simulateDay16({ closes: sim.closes, dailySigma: sessionSigma, rng });
  const r16 = evaluatePolicy({ grid: d16.grid, entry }, buildDay16Policy(entry, shares));
  const accessCost = r16.Eproceeds - r.Eproceeds; // + = Day-16 nets more (the flip costs you money too)
  const cn = document.getElementById('compareNote'); cn.textContent='';
  cn.append(
    txt('Waiting to a clean Day-16 exit nets an expected '),
    el('b', { textContent: fmtMoney(r16.Eproceeds) }),
    txt(` vs ${fmtMoney(r.Eproceeds)} for this Day-1 plan — a difference of `),
    el('b', { textContent: (accessCost>=0?'+':'')+fmtMoney(accessCost), style:'color:'+(accessCost>=0?'#28d17c':'#ff5c6c') }),
    txt(`. So the Day-1 flip ${accessCost>=0?'costs':'gains'} you roughly that much in expected proceeds, on top of the 6-month IPO-access block. Day-16 also carries ~11 trading days of overnight/gap risk this single-session plan does not (its sub-$${entry} sale odds: ${(r16.pSubBasisSale*100).toFixed(0)}%).`));

  const cc = document.getElementById('compareChart');
  if (compareChartRef) compareChartRef.destroy();
  compareChartRef = new Chart(cc, { type:'bar', data:{
    labels:['Sell @ open','Day-1 plan','Hold→close','Day-16 clean'],
    datasets:[{ label:'Expected proceeds', data:[atOpen.Eproceeds, r.Eproceeds, toClose.Eproceeds, r16.Eproceeds],
      backgroundColor:['#5a4b8a','#b58bff','#5a4b8a','#28d17c'] }] },
    options:{ plugins:{ legend:{ display:false } }, scales:{ y:{ ticks:{ callback:v=>'$'+(v/1000).toFixed(0)+'k' } } } } });
}
```

- [ ] **Step 5: Wire the risk slider into the existing listener block**

Find the event-listener block (around lines 367–377) and add, next to the other `g('...').addEventListener` lines:

```js
  g('risk').addEventListener('input', e=>{ state.risk=+e.target.value; setText('riskLbl', state.risk); render(); });
```

- [ ] **Step 6: Verify it renders and reacts**

```bash
cd ~/Desktop/spacex-ipo-model && npm test            # existing + new model tests still green
python3 -m http.server 8765 >/dev/null 2>&1 &         # serve (ES modules need HTTP)
sleep 1 && echo "open http://localhost:8765/ and scroll to 'Execution Plan'"
```
Expected (manual): the Execution Plan section shows three scenario buttons (Balanced highlighted), the recovery sentence with a live %, six metric cards, the ticket table with 4 OCO rows + residual, the checkpoint list, and the comparison note + 4-bar chart. Clicking scenarios and dragging the risk slider re-renders the numbers, tickets, and chart. Stop the server when done (`kill %1`).

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/spacex-ipo-model
git add index.html
git commit -m "feat: Execution Plan UI — scenarios, tickets, checkpoints, Day-16 compare"
```

---

### Task 7: Caveats, README, and final verification

**Files:**
- Modify: `index.html` (extend the existing "Not financial advice" caveat block)
- Modify: `README.md` (document the new section)

- [ ] **Step 1: Extend the on-page caveat**

In `index.html`, find the existing caveat block (the `<b>Not financial advice.</b> ...` paragraph) and append this sentence inside it, before the closing tag:

```html
 The Execution Plan models fills at 8 intraday steps (an approximation of true intraday highs/lows), assumes limit orders fill at the rung price and stops at the stop price (real fills can slip in fast moves or halts), and assumes the position is small relative to Day-1 volume. The Day-16 comparison assumes zero drift over ~11 trading days and is a planning estimate, not a forecast. Order types and the on-close (MOC/LOC) cutoff must be confirmed in your own Fidelity account; selling within 15 calendar days is a flip (6-month IPO-access block, first offense).
```

- [ ] **Step 2: Add a README section**

Append to `README.md`:

```markdown
## Execution Plan (Day-1)

The "Execution Plan" section turns the simulated price grid into a scaled sell plan for the $135
allocation, scored against all 10,000 paths:

- **Three postures** — Protect First / Balanced / Ride the Upside — plus a protection-aggressiveness
  slider. Each is time-phased: room to recover early, escalating stop protection into the close.
- **Fidelity tickets** — OCO brackets (sell-limit-up / sell-stop-down) per tranche, an MOC/LOC
  residual, and manual stop-escalation checkpoints with ET times. Built for Active Trader Pro.
- **Outcome stats** — expected proceeds, middle-90% range, P(net loss), P(sub-$135 sale), sell mix,
  vs. sell-at-open and hold-to-close baselines.
- **Day-1 vs Day-16** — a quantitative comparison of the flip (Day-1) plan against a clean Day-16
  exit, showing the implied dollar cost of the 15-day flip rule (6-month IPO-access block).

All scoring lives in pure functions in `model.js` (`evaluatePolicy`, `buildScenario`,
`ticketsFromPolicy`, `simulateDay16`, …) and is unit-tested in `test/model.test.js`.
**Not financial advice;** inputs (date, $135, share count) are user-supplied and unverified.
```

- [ ] **Step 3: Full verification**

```bash
cd ~/Desktop/spacex-ipo-model && npm test
```
Expected: all tests pass (existing + the new execution-layer tests from Tasks 1–5).

- [ ] **Step 4: Commit**

```bash
cd ~/Desktop/spacex-ipo-model
git add index.html README.md
git commit -m "docs: caveats + README for Day-1 execution plan"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §2 architecture → Tasks 1–6; §3 scoring engine → Task 1; §4 conditional recovery → Task 2; §5 three scenarios + risk slider → Tasks 3 & 6; §6 Fidelity tickets + checkpoints + open/stop nuances → Tasks 4 & 6 & 7; §7 Day-16 quantitative → Tasks 5 & 6; §8 UI → Task 6; §9 testing → Tasks 1–5; §11 caveats → Task 7. All sections mapped.

**Placeholder scan:** No TBD/TODO; every code step contains full code; every test asserts concrete values.

**Type consistency:** `evaluatePolicy` consumes `{grid,entry}` + `policy{shares,entry,tranches[{frac,limitPx}],stopSchedule[{from,stopPx}]}` consistently across Tasks 1, 3, 4, 5, 6. `ticketsFromPolicy` output (`ladder/residual/checkpoints/flatBy`) matches its Task-4 test and Task-6 rendering. `simulateDay16` returns `{grid,level16,meanLevel16}`, scored by the same `evaluatePolicy` in Tasks 5 & 6. `SCENARIO_NAMES` exported in Task 3, consumed in Task 6. `render()` calls `renderExecutionPlan(sim)`; `sim` carries `grid/closes/entry` (confirmed from existing `simulateDayOne` return).
