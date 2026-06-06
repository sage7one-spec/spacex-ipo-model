import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThresholdToCap } from '../model.js';
import { readFileSync } from 'node:fs';
import { parsePolymarketCurve } from '../model.js';
import { mulberry32, medianCapT, sampleCap, curveArrays, parsePolymarketCurve as ppc2 } from '../model.js';
import { parseHyperliquid } from '../model.js';

const polyEvent = JSON.parse(readFileSync(new URL('./fixtures/poly-event.json', import.meta.url)));
const hlMeta = JSON.parse(readFileSync(new URL('./fixtures/hl-meta.json', import.meta.url)));

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

test('parseHyperliquid extracts xyz:SPCX mark/oracle/funding', () => {
  const hl = parseHyperliquid(hlMeta);
  assert.ok(hl, 'should find xyz:SPCX');
  assert.ok(hl.mark > 50 && hl.mark < 1000, `mark ${hl.mark} implausible`);
  assert.ok(isFinite(hl.oracle) && isFinite(hl.prevDay) && isFinite(hl.funding));
  assert.equal(parseHyperliquid([{ universe: [] }, []]), null);
});
