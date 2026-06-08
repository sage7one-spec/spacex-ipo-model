import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseThresholdToCap,
  parsePolymarketCurve,
  mulberry32, medianCapT, sampleCap, curveArrays,
  parseHyperliquid,
  realizedVolFromCandles,
  disagreement, blendCenter,
  simulateDayOne,
  evaluatePolicy, sellAllAt,
  conditionalRecovery,
  buildScenario,
  ticketsFromPolicy,
  simulateDay16, buildDay16Policy,
} from '../model.js';

const polyEvent = JSON.parse(readFileSync(new URL('./fixtures/poly-event.json', import.meta.url)));
const hlMeta = JSON.parse(readFileSync(new URL('./fixtures/hl-meta.json', import.meta.url)));
const hlCandles = JSON.parse(readFileSync(new URL('./fixtures/hl-candles.json', import.meta.url)));

test('parseThresholdToCap handles $T and $B and decimals', () => {
  assert.equal(parseThresholdToCap('SpaceX IPO closing market cap above $1T?'), 1e12);
  assert.equal(parseThresholdToCap('...above $1.4T?'), 1.4e12);
  assert.equal(parseThresholdToCap('...above $800B?'), 800e9);
  assert.equal(parseThresholdToCap('no dollar amount here'), null);
});

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

test('medianCapT brackets the 50% crossing', () => {
  const { thresh, above } = curveArrays(parsePolymarketCurve(polyEvent));
  const med = medianCapT(thresh, above);
  // fixture data: median cap between $2.0T and $2.2T
  assert.ok(med > 1.8 && med < 2.6, `median cap ${med} out of expected range`);
});

test('sampleCap is deterministic under a seeded RNG and stays in plausible range', () => {
  const { thresh, above } = curveArrays(parsePolymarketCurve(polyEvent));
  const rng = mulberry32(20260611);
  const samples = Array.from({ length: 5000 }, () => sampleCap(thresh, above, rng));
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(mean > 1.5 && mean < 3.0, `mean cap ${mean} implausible`);
  // determinism: same seed → same first draw
  const r2 = mulberry32(20260611);
  assert.equal(sampleCap(thresh, above, r2), samples[0]);
});

test('parseHyperliquid extracts xyz:SPCX mark/oracle/funding', () => {
  const hl = parseHyperliquid(hlMeta);
  assert.ok(hl, 'should find xyz:SPCX');
  assert.ok(hl.mark > 50 && hl.mark < 1000, `mark ${hl.mark} implausible`);
  assert.ok(isFinite(hl.oracle) && isFinite(hl.prevDay) && isFinite(hl.funding));
  assert.equal(parseHyperliquid([{ universe: [] }, []]), null);
});

test('realizedVolFromCandles returns positive sigmas and a 0-100 slider value', () => {
  const v = realizedVolFromCandles(hlCandles);
  assert.ok(v && v.hourlySigma > 0 && v.sessionSigma > v.hourlySigma);
  assert.ok(v.sliderVal >= 0 && v.sliderVal <= 100);
  assert.equal(realizedVolFromCandles([]), null);
});

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

test('simulateDayOne produces well-formed, deterministic, blend-responsive output', () => {
  const { thresh, above } = curveArrays(parsePolymarketCurve(polyEvent));
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
  // Stop activates only at frac >= 0.5 (from:0.5), so it is dormant at k=0.
  // At k=1 (frac=1.0), price 115 satisfies BOTH limit (115 >= 110) AND stop (115 <= 120)
  // simultaneously — a genuine same-step collision.
  // Limits fill first → 100@110=11000; if the stop ran first it would be 100@120=12000.
  // Asserting 11000 proves limits fill before the stop within the same step.
  const grid = [ [100], [115] ];
  const policy = { shares: 100, entry: 100,
    tranches: [ { frac: 1.0, limitPx: 110 } ],
    stopSchedule: [ { from: 0.5, stopPx: 120 } ] };
  const r = evaluatePolicy({ grid, entry: 100 }, policy);
  assert.equal(r.Eproceeds, 100 * 110);   // limit price, not the stop price
  assert.equal(r.mix.upsidePct, 1);
});

test('sellAllAt returns mean column price × shares', () => {
  const paths = { grid: [ [100, 200], [0, 0] ], entry: 100 };
  assert.equal(sellAllAt(paths, 0, 10).Eproceeds, 1500); // mean(100,200)=150 × 10
});

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
