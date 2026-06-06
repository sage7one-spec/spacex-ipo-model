// model.js — pure functions only (no DOM, no fetch). Imported by index.html and tests.

export function parseThresholdToCap(question) {
  const m = String(question).match(/\$([0-9]*\.?[0-9]+)\s*([TB])/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n * (m[2].toUpperCase() === 'T' ? 1e12 : 1e9);
}

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
