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
//   paths : { grid: number[steps+1][N] }            (grid-length-agnostic; entry/shares come from policy)
//   policy: { shares, entry, coreAtOpenFrac?, tranches:[{frac,limitPx}], stopSchedule:[{from,stopPx}] }
// Tie-break: within a step, upside limits fill BEFORE the protective stop.
// The stop covers the whole remaining position. Residual sells at the close price.
export function evaluatePolicy(paths, policy) {
  const { grid } = paths;
  const steps = grid.length - 1;
  const N = grid[0].length;
  const { shares, entry, coreAtOpenFrac = 0, tranches, stopSchedule } = policy;
  const basis = shares * entry;
  const proceeds = new Array(N);
  let subCount = 0, subSharesSum = 0, netLoss = 0, openSum = 0, upSum = 0, stopSum = 0, closeSum = 0;

  const activeStop = (frac) => {
    let s = null;
    for (const e of stopSchedule) if (e.from <= frac + 1e-9) s = e.stopPx;
    return s;
  };

  for (let p = 0; p < N; p++) {
    let left = shares, value = 0, subShares = 0;
    const open = grid[0][p];
    if (coreAtOpenFrac > 0) {                                  // 0) market-sell the core at the open
      const q = shares * coreAtOpenFrac;
      value += q * open; if (open < entry) subShares += q; openSum += q; left -= q;
    }
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
    mix: { openPct: openSum / tot, upsidePct: upSum / tot, stopPct: stopSum / tot, closePct: closeSum / tot },
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
  protect:  { core: 0.40, rungs: [0.02, 0.05, 0.09], splits: [0.22, 0.18, 0.12],
              stops: [{ from: 0.10, pct: -0.08 }, { from: 0.55, pct: -0.04 }, { from: 0.85, pct: -0.02 }] },
  balanced: { core: 0.30, rungs: [0.03, 0.07, 0.12], splits: [0.25, 0.20, 0.15],
              stops: [{ from: 0.35, pct: -0.07 }, { from: 0.70, pct: -0.04 }, { from: 0.90, pct: -0.02 }] },
  ride:     { core: 0.15, rungs: [0.06, 0.15, 0.28], splits: [0.25, 0.25, 0.20],
              stops: [{ from: 0.20, pct: -0.12 }, { from: 0.80, pct: -0.04 }] },
};

// Upside rungs anchor ABOVE the reference opening price (refPx). The protective stop is
// refPx-anchored but clamped to [entry, refPx] — never below the $135 basis, never above
// the reference (which would imply an above-market stop). riskLevel 0..100: higher → higher
// rungs + smaller core (ride the upside); lower → larger core sold at the open (protect).
export function buildScenario(name, riskLevel, ctx) {
  const def = SCENARIO_DEFS[name];
  if (!def) throw new Error(`unknown scenario: ${name}`);
  const { entry, shares, refPx } = ctx;
  const ref = refPx ?? entry;
  const f = 1 + (riskLevel - 50) / 100 * 0.5;
  const core = Math.max(0, Math.min(1, def.core * (2 - f)));
  const stopAt = (pct) => +Math.min(Math.max(ref * (1 + pct * f), entry), ref).toFixed(2);
  return {
    name, entry, shares, refPx: ref, coreAtOpenFrac: core,
    tranches: def.rungs.map((r, i) => ({ frac: def.splits[i], limitPx: +(ref * (1 + r * f)).toFixed(2) })),
    stopSchedule: def.stops.map(s => ({ from: s.from, stopPx: stopAt(s.pct) })),
  };
}
export const SCENARIO_NAMES = Object.keys(SCENARIO_DEFS);

// Render a policy as Fidelity-executable tickets. Each upside tranche is an OCO
// (sell-limit-up / sell-stop-down) on its shares; equal stop levels across tranches
// behave as one whole-position stop (matches evaluatePolicy). Residual = MOC/LOC.
export function ticketsFromPolicy(policy, opts = {}) {
  const { shares, coreAtOpenFrac = 0, tranches, stopSchedule } = policy;
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
  const coreShares = r(shares * coreAtOpenFrac);
  const ladder = tranches.map((t, i) => ({
    tranche: i + 1, shares: r(shares * t.frac),
    limitPx: t.limitPx, stopPx: firstStop ? firstStop.stopPx : null,
    type: 'OCO', tif: 'Day',
  }));
  // reconcile the residual against the rounded rows so the ticket table totals exactly `shares`
  const residualShares = Math.max(0, Math.round(shares) - coreShares - ladder.reduce((a, L) => a + L.shares, 0));
  const checkpoints = stopSchedule.map((s, i) => ({
    atFrac: s.from, clock: clock(s.from), stopPx: s.stopPx,
    action: i === 0
      ? `Add a protective Sell Stop at $${s.stopPx} on all unsold shares — place it once SPCX has a printed price (new IPOs reject stops until a quote exists).`
      : `Cancel the prior stop and re-enter it at $${s.stopPx} on all unsold shares.`,
  }));
  return {
    coreAtOpen: {
      shares: coreShares, type: 'MKT',
      note: `Sell at Market (or a marketable limit) on the opening print to lock the in-the-money gain. This is the core of the plan when SPCX opens well above your $135 basis.`,
    },
    ladder,
    residual: {
      shares: residualShares, type: 'MOC',
      note: `Sell-on-Close (MOC/LOC) for any unsold shares; enter before the ~3:45pm ET cutoff. If your account/security can't place on-close orders, sell at Market by ~3:50pm. The active stop also covers this residual until then.`,
    },
    checkpoints,
    flatBy: clock(1),
  };
}

// Fidelity ATP order set for Case B: a buy-limit at/below the limit, an OCO bracket
// attached on fill, and an MOC/LOC residual. Mirrors the bottom-feeder execution.
export function bottomFeedTicket(cfg) {
  const px = (n) => n.toFixed(2);
  const { limitPx = 135, capital = 100000, targetPct = 0.06, stopPct = 0.05 } = cfg;
  const shares = Math.round(capital / limitPx);
  const target = +(limitPx * (1 + targetPct)).toFixed(2);
  const stop = +(limitPx * (1 - stopPct)).toFixed(2);
  const lim = +limitPx.toFixed(2);
  // all three tickets reference the same lot; the OCO bracket and the MOC residual are mutually exclusive exit paths, not additive lots.
  return {
    entry: {
      type: 'BUY LIMIT', shares, limitPx: lim, tif: 'Day',
      note: `Buy ${shares} sh limit $${px(lim)} — deploys ~$${(shares * lim).toLocaleString()} only if SPCX trades down to your limit. If it never prints ≤ $${px(lim)}, nothing fills and you keep $${capital.toLocaleString()} in cash.`,
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

// For each early step k, P(close > entry | price at step k < entry).
export function conditionalRecovery(grid, entry, ks = [1, 2, 3]) {
  const steps = grid.length - 1, N = grid[0].length, close = grid[steps];
  return ks.filter(k => k >= 0 && k <= steps).map(k => {
    let dips = 0, recover = 0;
    for (let p = 0; p < N; p++) if (grid[k][p] < entry) { dips++; if (close[p] > entry) recover++; }
    return { k, frac: k / steps, dips, p: dips ? recover / dips : null };
  });
}

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
