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
  if (u >= above[0]) { const f = (u - above[0]) / ((100 - above[0]) || 1); return thresh[0] * (1 - f * 0.15); } // below lowest quoted threshold: extrapolate up to 15% under it
  if (u <= above[last]) { const f = (above[last] - u) / (above[last] || 1); return thresh[last] + f * (thresh[last] * 0.375); } // above highest quoted threshold: extrapolate up to 37.5% over it
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

export function disagreement(hlMark, polyMedianPerShare) {
  const avg = (hlMark + polyMedianPerShare) / 2;
  const absPct = avg > 0 ? Math.abs(hlMark - polyMedianPerShare) / avg : 0;
  const tier = absPct < 0.05 ? 'high' : absPct < 0.15 ? 'moderate' : 'low';
  return { absPct, tier, deltaUsd: hlMark - polyMedianPerShare };
}

export function blendCenter(hlMark, polyMedianPerShare, w) {
  return w * hlMark + (1 - w) * polyMedianPerShare;
}

// Hourly candles → realized vol. Maps daily sigma into v1's slider band: sigMid = 0.02 + 0.18*(slider/100).
export function realizedVolFromCandles(candles) {
  const closes = (candles || []).map(k => +k.c).filter(x => isFinite(x) && x > 0);
  if (closes.length < 3) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rets.length - 1);
  const hourlySigma = Math.sqrt(varr);
  const sessionSigma = hourlySigma * Math.sqrt(6.5); // scale 24/7 hourly vol to the ~6.5h Day-1 equity trading session this model simulates
  const sliderVal = Math.max(0, Math.min(100, Math.round((sessionSigma - 0.02) / 0.18 * 100)));
  return { hourlySigma, sessionSigma, sliderVal };
}

// Day-1 open→close returns from public mega-IPO first-day histories (ported from v1 model).
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
// Returns only { Eproceeds, avgSalePx } — a partial shape vs evaluatePolicy, sufficient
// for baseline comparison (do not spread it into an evaluatePolicy-shaped consumer).
export function sellAllAt(paths, stepIndex, shares) {
  const col = paths.grid[stepIndex];
  const m = col.reduce((a, b) => a + b, 0) / col.length;
  return { Eproceeds: m * shares, avgSalePx: m };
}

// ---- Scenario presets (time-phased, risk-modulated) ---------------------

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

// For each early step k, P(close > entry | price at step k < entry).
export function conditionalRecovery(grid, entry, ks = [1, 2, 3]) {
  const steps = grid.length - 1, N = grid[0].length, close = grid[steps];
  return ks.filter(k => k >= 0 && k <= steps).map(k => {
    let dips = 0, recover = 0;
    for (let p = 0; p < N; p++) if (grid[k][p] < entry) { dips++; if (close[p] > entry) recover++; }
    return { k, frac: k / steps, dips, p: dips ? recover / dips : null };
  });
}
