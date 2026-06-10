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
  postIpoBands, SPCX_EVENT_DRIFT, peakReachProb,
  sampleBridgeMin, sampleBridgeMax, sampleCapU, normalizeTimingCurve,
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

// ---- v4 fixes: bridge scale, interval extremes, rank coupling, normalization ----

test('sampleBridgeMin/Max: closed-form interval extremes bracket the endpoints', () => {
  const a = Math.log(100), b = Math.log(110), s2 = 0.03 * 0.03;
  // u → 1 ⇒ ln u → 0 ⇒ extreme collapses onto the nearer endpoint
  assert.ok(Math.abs(sampleBridgeMin(a, b, s2, 0.999999) - Math.min(a, b)) < 1e-3);
  assert.ok(Math.abs(sampleBridgeMax(a, b, s2, 0.999999) - Math.max(a, b)) < 1e-3);
  // any u: min ≤ both endpoints, max ≥ both endpoints
  for (const u of [0.05, 0.3, 0.7]) {
    assert.ok(sampleBridgeMin(a, b, s2, u) <= Math.min(a, b) + 1e-12);
    assert.ok(sampleBridgeMax(a, b, s2, u) >= Math.max(a, b) - 1e-12);
  }
  // exact closed form: m = (a+b − √((a−b)² − 2s²·ln u)) / 2
  const u = 0.4;
  const expected = (a + b - Math.sqrt((a - b) ** 2 - 2 * s2 * Math.log(u))) / 2;
  assert.ok(Math.abs(sampleBridgeMin(a, b, s2, u) - expected) < 1e-12);
});

test('simulateDayOne: bridge midpoint dispersion is σ/2 (consistent conditional scale)', () => {
  const { thresh, above } = curveArrays(parsePolymarketCurve(polyEvent));
  const vol = 100, sigMid = 0.02 + 0.18 * (vol / 100); // 0.20
  const sim = simulateDayOne({ thresh, above, shares: 12.96e9, hlMark: 165, w: 0.5,
    offer: 135, vol, N: 4000, steps: 8, rng: mulberry32(42) });
  // residual at the middle node vs the log-linear open→close interpolation is the pure
  // bridge term: SD should be σ/2, not σ (the old 2σ/√n scale doubled it)
  const res = [];
  for (let p = 0; p < 4000; p++) {
    const lO = Math.log(sim.grid[0][p]), lC = Math.log(sim.grid[8][p]);
    res.push(Math.log(sim.grid[4][p]) - (lO + lC) / 2);
  }
  const m = res.reduce((a, b) => a + b, 0) / res.length;
  const sd = Math.sqrt(res.reduce((a, b) => a + (b - m) ** 2, 0) / (res.length - 1));
  assert.ok(Math.abs(sd - sigMid / 2) < 0.05 * sigMid, `bridge midpoint SD ${sd} should be ≈ ${sigMid / 2}`);
});

test('simulateDayOne: returns per-interval extremes and per-path cap uniforms', () => {
  const { thresh, above } = curveArrays(parsePolymarketCurve(polyEvent));
  const sim = simulateDayOne({ thresh, above, shares: 12.96e9, hlMark: 165, w: 0.5,
    offer: 135, vol: 60, N: 500, steps: 8, rng: mulberry32(7) });
  assert.equal(sim.gridMin.length, 8);          // one row per interval
  assert.equal(sim.gridMax.length, 8);
  assert.equal(sim.gridMin[0].length, 500);
  assert.equal(sim.capU.length, 500);
  for (const u of sim.capU) assert.ok(u >= 0 && u < 100);
  for (let k = 0; k < 8; k++) for (let p = 0; p < 500; p++) {
    const lo = Math.min(sim.grid[k][p], sim.grid[k + 1][p]);
    const hi = Math.max(sim.grid[k][p], sim.grid[k + 1][p]);
    assert.ok(sim.gridMin[k][p] <= lo + 1e-9, 'interval min must not exceed endpoint min');
    assert.ok(sim.gridMax[k][p] >= hi - 1e-9, 'interval max must not undercut endpoint max');
  }
  // path lows/highs must incorporate the sampled extremes
  for (let p = 0; p < 500; p++) {
    const iMin = Math.min(...sim.gridMin.map(r => r[p]));
    const iMax = Math.max(...sim.gridMax.map(r => r[p]));
    assert.ok(Math.abs(sim.lows[p] - iMin) < 1e-9);
    assert.ok(Math.abs(sim.highs[p] - iMax) < 1e-9);
  }
});

test('evaluatePolicy: interval extremes trigger limit fills nodes would miss', () => {
  const paths = { grid: [[100], [100]], gridMin: [[98]], gridMax: [[120]] };
  const policy = { shares: 100, entry: 100,
    tranches: [{ frac: 1.0, limitPx: 110 }], stopSchedule: [] };
  const r = evaluatePolicy(paths, policy);
  assert.equal(r.Eproceeds, 100 * 110);   // fills at the rung mid-interval
  assert.equal(r.mix.upsidePct, 1);
});

test('evaluatePolicy: interval extremes trigger the stop, limits still fill first', () => {
  const stopPaths = { grid: [[100], [100]], gridMin: [[95]], gridMax: [[101]] };
  const stopPolicy = { shares: 100, entry: 100, tranches: [],
    stopSchedule: [{ from: 0, stopPx: 99 }] };
  const rs = evaluatePolicy(stopPaths, stopPolicy);
  assert.equal(rs.Eproceeds, 100 * 99);   // stop fires mid-interval at the stop price
  assert.equal(rs.mix.stopPct, 1);

  const bothPaths = { grid: [[100], [100]], gridMin: [[95]], gridMax: [[115]] };
  const bothPolicy = { shares: 100, entry: 100,
    tranches: [{ frac: 1.0, limitPx: 110 }],
    stopSchedule: [{ from: 0, stopPx: 99 }] };
  const rb = evaluatePolicy(bothPaths, bothPolicy);
  assert.equal(rb.Eproceeds, 100 * 110);  // tie-break preserved: limit before stop
});

test('evaluatePolicy: reports the Monte Carlo standard error of mean proceeds', () => {
  const grid = [[100, 100], [110, 90]];
  const policy = { shares: 100, entry: 100, tranches: [], stopSchedule: [] };
  const r = evaluatePolicy({ grid }, policy);
  // proceeds [11000, 9000]: sd(n−1) = √2·1000, SE = sd/√2 = 1000
  assert.equal(r.seProceeds, 1000);
});

test('simulateBottomFeed: interval lows trigger fills nodes would miss', () => {
  // wide bracket (target 202.50 / stop 94.50) so no exit triggers → residual at close 150
  const paths = { grid: [[150], [150]], gridMin: [[130]], gridMax: [[151]] };
  const r = simulateBottomFeed(paths, { limitPx: 135, capital: 100000, targetPct: 0.5, stopPct: 0.3 });
  assert.equal(r.pFill, 1);
  const shares = 100000 / 135;
  assert.ok(Math.abs(r.nets[0] - (shares * 150 - 100000)) < 1e-6);
  assert.equal(r.mix.closePct, 1);
});

test('simulateBottomFeed: interval highs after the fill hit the target', () => {
  const paths = { grid: [[150], [135], [140]],
    gridMin: [[134], [134]], gridMax: [[150], [144]] };  // target 143.10 only inside interval 1
  const r = simulateBottomFeed(paths, { limitPx: 135, capital: 100000, targetPct: 0.06, stopPct: 0.05 });
  const shares = 100000 / 135, target = 135 * 1.06;
  assert.equal(r.mix.targetPct, 1);
  assert.ok(Math.abs(r.nets[0] - (shares * target - 100000)) < 1e-6);
});

test('simulateBottomFeed: reports the Monte Carlo standard error of mean net', () => {
  const paths = { grid: [[200, 135], [200, 138], [200, 138]] }; // path0 no-fill ($0), path1 fills, closes 138
  const r = simulateBottomFeed(paths, { limitPx: 135, capital: 100000, targetPct: 0.5, stopPct: 0.5 });
  const net1 = (100000 / 135) * 138 - 100000;
  const m = net1 / 2, sd = Math.sqrt(((0 - m) ** 2 + (net1 - m) ** 2) / 1);
  assert.ok(Math.abs(r.net.se - sd / Math.sqrt(2)) < 1e-6);
});

test('sampleCapU: low uniform → high cap, deterministic, matches sampleCap draw', () => {
  const { thresh, above } = curveArrays(parsePolymarketCurve(polyEvent));
  assert.ok(sampleCapU(thresh, above, 5) > sampleCapU(thresh, above, 95));
  const rng = mulberry32(99);
  const u = mulberry32(99)() * 100;
  assert.equal(sampleCap(thresh, above, rng), sampleCapU(thresh, above, u));
});

test('simulatePostIPO: rank-coupled terminals keep winners above losers', () => {
  // path0 closed Day 1 high with a low uniform (= high cap); path1 the reverse
  const closes = [200, 100], us = [5, 95];
  const r = simulatePostIPO({ closes, dailySigma: 0.005, rng: mulberry32(31), days: 20,
    polyTerminal: { thresh: [1.0, 2.0, 3.0], above: [99, 50, 1], shares: 12.96e9, us },
    anchorStrength: 0.8 });
  assert.ok(r.grid[20][0] > r.grid[20][1],
    'the high-close path must anchor to its own high terminal, not an independent draw');
});

test('normalizeTimingCurve: divides out P(IPO) using the low-threshold plateau', () => {
  const rows = [{ capT: 1, pAbove: 99 }, { capT: 2, pAbove: 49.5 }, { capT: 3, pAbove: 9.9 }];
  const n = normalizeTimingCurve(rows);
  assert.ok(Math.abs(n[0].pAbove - 100) < 1e-9);
  assert.ok(Math.abs(n[1].pAbove - 50) < 1e-9);
  assert.ok(Math.abs(n[2].pAbove - 10) < 1e-9);
  // explicit pIpo wins, clamped to 100
  const e = normalizeTimingCurve(rows, 0.9);
  assert.equal(e[0].pAbove, 100);
  // degenerate inputs pass through
  assert.deepEqual(normalizeTimingCurve([]), []);
});

test('realizedVolFromCandles: IPO-day multiplier scales session vol, not hourly vol', () => {
  const v1 = realizedVolFromCandles(hlCandles);
  const v2 = realizedVolFromCandles(hlCandles, 2);
  assert.equal(v2.hourlySigma, v1.hourlySigma);
  assert.ok(Math.abs(v2.sessionSigma - 2 * v1.sessionSigma) < 1e-12);
  assert.ok(v2.sliderVal > v1.sliderVal);
});

test('ticketsFromPolicy: checkpoint stop covers only shares without an OCO bracket', () => {
  const policy = buildScenario('balanced', 50, { entry: 135, shares: 1111, refPx: 174 });
  const t = ticketsFromPolicy(policy);
  assert.ok(!/all unsold shares/.test(t.checkpoints[0].action),
    'must not instruct a stop on shares already covered by OCO brackets (would oversell)');
  assert.match(t.checkpoints[0].action, /OCO|residual/i);
});

// ---- v5 quick fixes: PAVA clamp, fitted tails, Case B fill realism ----

test('parsePolymarketCurve: pools adjacent violators instead of one-sided truncation', () => {
  const ev = [{ markets: [
    { question: 'above $1T?', outcomePrices: '["0.90","0.10"]' },
    { question: 'above $2T?', outcomePrices: '["0.95","0.05"]' },   // thin-market violation
    { question: 'above $3T?', outcomePrices: '["0.50","0.50"]' },
  ]}];
  const c = parsePolymarketCurve(ev);
  assert.equal(c.length, 3);
  // PAVA averages the violating pair (90,95) → (92.5, 92.5); old clamp truncated to (90, 90)
  assert.ok(Math.abs(c[0].pAbove - 92.5) < 1e-9, `got ${c[0].pAbove}`);
  assert.ok(Math.abs(c[1].pAbove - 92.5) < 1e-9, `got ${c[1].pAbove}`);
  assert.equal(c[2].pAbove, 50);
});

test('sampleCapU: tails are continuous at the boundary buckets', () => {
  const thresh = [1, 2, 3], above = [90, 50, 10];
  assert.ok(Math.abs(sampleCapU(thresh, above, 90) - 1) < 1e-9);
  assert.ok(Math.abs(sampleCapU(thresh, above, 10) - 3) < 1e-9);
});

test('sampleCapU: lower tail continues the first bucket inverse-CDF slope', () => {
  const thresh = [1, 2, 3], above = [90, 50, 10];
  // slope = (2−1)/(90−50) = 0.025 $T per percent; u=100 → 1 − 10·0.025 = 0.75
  assert.ok(Math.abs(sampleCapU(thresh, above, 100) - 0.75) < 1e-9);
  // floored at half the lowest threshold
  const steep = sampleCapU([1, 1.01], [90, 1], 100);
  assert.ok(steep >= 0.5 - 1e-9);
});

test('sampleCapU: upper tail is exponential fitted to the last two buckets, clamped at 2× the top threshold', () => {
  const thresh = [1, 2, 3], above = [90, 50, 10];
  // λ = ln(50/10)/(3−2) = ln 5; u=5 → 3 + ln(10/5)/ln 5
  const expected = 3 + Math.log(2) / Math.log(5);
  assert.ok(Math.abs(sampleCapU(thresh, above, 5) - expected) < 1e-9);
  assert.ok(sampleCapU(thresh, above, 1e-9) <= 6 + 1e-9);   // clamp
  // monotone: deeper into the tail → larger cap
  assert.ok(sampleCapU(thresh, above, 2) > sampleCapU(thresh, above, 8));
});

test('simulateBottomFeed: open below the limit fills at the open price (price improvement)', () => {
  // wide bracket so nothing triggers → residual sells at close; profit = close − open
  const paths = gridFromPath([120, 121, 122, 123]);
  const r = simulateBottomFeed(paths, { limitPx: 135, capital: 100000, targetPct: 0.5, stopPct: 0.5 });
  const shares = 100000 / 135;
  assert.equal(r.pFill, 1);
  assert.ok(Math.abs(r.nets[0] - shares * (123 - 120)) < 1e-6, `got ${r.nets[0]}`);
});

test('simulateBottomFeed: bracket stop never exits above the actual fill price', () => {
  // fill at open 120; stop leg (128.25) is instantly marketable → flat exit, not a fake +stop−fill gain
  const paths = gridFromPath([120, 121, 122, 123]);
  const r = simulateBottomFeed(paths, { limitPx: 135, capital: 100000, targetPct: 0.06, stopPct: 0.05 });
  assert.ok(Math.abs(r.nets[0] - 0) < 1e-6, `got ${r.nets[0]}`);
  assert.equal(r.mix.stopPct, 1);
});

test('postIpoBands: pBelow grows with horizon for a martingale started above the level', () => {
  const closes = Array.from({ length: 4000 }, () => 165);
  const r = simulatePostIPO({ closes, dailySigma: 0.03, rng: mulberry32(17), days: 20 });
  const bands = postIpoBands(r.grid, 135);
  assert.ok(bands[20].pBelow >= bands[5].pBelow, 'later-day underwater prob should not shrink');
});

test('SPCX_EVENT_DRIFT: length 20, non-negative, mass on the catalyst days only', () => {
  assert.equal(SPCX_EVENT_DRIFT.length, 20);
  assert.ok(SPCX_EVENT_DRIFT.every(x => x >= 0));
  // catalysts: Day 4 (idx3), Day 5 (idx4), Day 15 (idx14), Day 16 (idx15)
  for (const i of [3, 4, 14, 15]) assert.ok(SPCX_EVENT_DRIFT[i] > 0, `expected drift at idx ${i}`);
  for (const i of [0, 1, 2, 6, 10, 19]) assert.equal(SPCX_EVENT_DRIFT[i], 0, `expected no drift at idx ${i}`);
});

test('simulatePostIPO: event overlay lifts the terminal vs the same paths with weight 0', () => {
  const closes = Array.from({ length: 6000 }, () => 150);
  const base = simulatePostIPO({ closes, dailySigma: 0.02, rng: mulberry32(101), days: 20,
    eventCurve: SPCX_EVENT_DRIFT, eventWeight: 0 });
  const lift = simulatePostIPO({ closes, dailySigma: 0.02, rng: mulberry32(101), days: 20,
    eventCurve: SPCX_EVENT_DRIFT, eventWeight: 1 });
  const meanLast = g => g.grid[20].reduce((a, b) => a + b, 0) / g.grid[20].length;
  assert.ok(meanLast(lift) > meanLast(base), 'event overlay should raise the day-20 mean');
});

test('simulatePostIPO: eventWeight 0 (default) is identical to no eventCurve — pure martingale untouched', () => {
  const closes = Array.from({ length: 2000 }, () => 150);
  const a = simulatePostIPO({ closes, dailySigma: 0.02, rng: mulberry32(5), days: 20 });
  const b = simulatePostIPO({ closes, dailySigma: 0.02, rng: mulberry32(5), days: 20,
    eventCurve: SPCX_EVENT_DRIFT, eventWeight: 0 });
  assert.equal(a.grid[20][0], b.grid[20][0]);
  assert.equal(a.grid[20][1999], b.grid[20][1999]);
});

test('peakReachProb: ever ≥ at, both in [0,1], and a higher level is rarer', () => {
  const closes = Array.from({ length: 4000 }, () => 150);
  const r = simulatePostIPO({ closes, dailySigma: 0.03, rng: mulberry32(202), days: 20 });
  const lo = peakReachProb(r.grid, 200, 15);
  const hi = peakReachProb(r.grid, 270, 15);
  for (const x of [lo, hi]) {
    assert.ok(x.everPct >= x.atPct - 1e-9, 'ever-reached must be ≥ at-day');
    assert.ok(x.everPct >= 0 && x.everPct <= 1 && x.atPct >= 0 && x.atPct <= 1);
  }
  assert.ok(lo.everPct >= hi.everPct, 'reaching a lower level should be at least as likely');
  assert.equal(hi.throughDay, 15);
});

test('peakReachProb: a path that spikes then fades counts in everPct but not atPct', () => {
  // one path: rises through 270 at day 2, falls back below by the cutoff day
  const grid = [
    [135], [200], [275], [260], [150], [140],
  ];
  const r = peakReachProb(grid, 270, 5);
  assert.equal(r.everPct, 1);
  assert.equal(r.atPct, 0);
});
