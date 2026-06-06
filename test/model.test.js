import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThresholdToCap } from '../model.js';
import { readFileSync } from 'node:fs';
import { parsePolymarketCurve } from '../model.js';

const polyEvent = JSON.parse(readFileSync(new URL('./fixtures/poly-event.json', import.meta.url)));

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
