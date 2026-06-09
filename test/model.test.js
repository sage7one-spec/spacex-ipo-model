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
  netDollars, fmtNet,
  simulateBottomFeed,
  bottomFeedTicket,
  MEGA_IPO_POSTIPO_CURVE, simulatePostIPO,
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

test('evaluatePolicy: coreAtOpenFrac sells at the open price', () => {
  const grid = [ [100, 100], [120, 90], [130, 80] ];
  const policy = { shares: 100, entry: 100, coreAtOpenFrac: 0.5, tranches: [], stopSchedule: [] };
  const r = evaluatePolicy({ grid, entry: 100 }, policy);
  // each path: 50 @ open 100 = 5000; residual 50 @ close → path0 50*130, path1 50*80
  assert.equal(r.Eproceeds, (11500 + 9000) / 2);  // 10250
  assert.equal(r.mix.openPct, 0.5);
  assert.equal(r.mix.closePct, 0.5);
  assert.equal(r.pSubBasisSale, 0.5);             // path1 close 80 < entry 100
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

test('buildScenario: balanced anchors rungs to refPx, not entry; has a core', () => {
  const p = buildScenario('balanced', 50, { entry: 135, shares: 1111, refPx: 174 });
  assert.equal(p.name, 'balanced');
  assert.ok(p.coreAtOpenFrac > 0);
  assert.equal(p.tranches.length, 3);
  assert.equal(p.tranches[0].limitPx, +(174 * 1.03).toFixed(2)); // rung above refPx
  assert.ok(p.tranches[0].limitPx > 135);
  for (const s of p.stopSchedule) assert.ok(s.stopPx >= 135 && s.stopPx <= 174); // clamped [entry, refPx]
});

test('buildScenario: stop clamps to <= refPx when refPx is below basis', () => {
  const p = buildScenario('balanced', 50, { entry: 135, shares: 1111, refPx: 130 });
  for (const s of p.stopSchedule) assert.ok(s.stopPx <= 130 + 1e-9);
});

test('buildScenario: higher riskLevel raises rungs and shrinks the core', () => {
  const lo = buildScenario('balanced', 0,   { entry: 135, shares: 1111, refPx: 174 });
  const hi = buildScenario('balanced', 100, { entry: 135, shares: 1111, refPx: 174 });
  assert.ok(hi.tranches[0].limitPx > lo.tranches[0].limitPx);
  assert.ok(hi.coreAtOpenFrac < lo.coreAtOpenFrac);
});

test('buildScenario: unknown name throws', () => {
  assert.throws(() => buildScenario('nope', 50, { entry: 135, shares: 1111, refPx: 174 }));
});

test('ticketsFromPolicy: core-at-open + OCO ladder + residual + checkpoints', () => {
  const policy = buildScenario('balanced', 50, { entry: 135, shares: 1111, refPx: 174 });
  const t = ticketsFromPolicy(policy);
  assert.ok(t.coreAtOpen.shares > 0);
  assert.equal(t.coreAtOpen.type, 'MKT');
  assert.equal(t.ladder.length, 3);
  assert.equal(t.ladder[0].type, 'OCO');
  assert.equal(t.ladder[0].tif, 'Day');
  assert.equal(t.ladder[0].limitPx, policy.tranches[0].limitPx);
  assert.equal(t.ladder[0].stopPx, policy.stopSchedule[0].stopPx);
  const laddered = t.ladder.reduce((a, r) => a + r.shares, 0);
  assert.ok(Math.abs(t.coreAtOpen.shares + laddered + t.residual.shares - 1111) <= t.ladder.length + 2);
  assert.equal(t.residual.type, 'MOC');
  assert.equal(t.checkpoints.length, policy.stopSchedule.length);
  assert.match(t.checkpoints[0].clock, /ET$/);
});

test('ticketsFromPolicy: clock maps session fraction to ET window', () => {
  const policy = buildScenario('balanced', 50, { entry: 135, shares: 1111, refPx: 174 });
  const t = ticketsFromPolicy(policy, { openMin: 600, closeMin: 960 });
  assert.equal(t.flatBy, '4:00pm ET');
});

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
    [135, 135, 130, 120], // fill at step0; step3=120 <= 128.25 stop
  ].reduce((cols, path) => { path.forEach((px, k) => { (cols[k] ||= []).push(px); }); return cols; }, []) };
  const r = simulateBottomFeed(paths, { limitPx: 135, capital: 100000, targetPct: 0.06, stopPct: 0.05 });
  const m = r.mix;
  assert.ok(Math.abs((m.targetPct + m.stopPct + m.closePct + m.noFillPct) - 1) < 1e-9);
});

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
  const thresh = [1.0, 1.6, 2.2], above = [99, 50, 1], shares = 12.96e9; // median cap ~1.6T → ~$123/share
  const free = simulatePostIPO({ closes, dailySigma: 0.03, rng: mulberry32(21), days: 20, anchorStrength: 0 });
  const anch = simulatePostIPO({ closes, dailySigma: 0.03, rng: mulberry32(21), days: 20, polyTerminal: { thresh, above, shares }, anchorStrength: 0.6 });
  const med = (col) => [...col].sort((a, b) => a - b)[Math.floor(col.length / 2)];
  assert.ok(med(anch.grid[20]) < med(free.grid[20]), 'anchored terminal should sit below the free-walk terminal');
});

test('MEGA_IPO_POSTIPO_CURVE is a 21-point normalized level curve starting at 1.0', () => {
  assert.equal(MEGA_IPO_POSTIPO_CURVE.length, 21);
  assert.equal(MEGA_IPO_POSTIPO_CURVE[0], 1.0);
});
