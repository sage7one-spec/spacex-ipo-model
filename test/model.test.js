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
