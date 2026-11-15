// Cashback ("rebate on losses") calculator for the Apex Games.
//   node tools/cashback-model.mjs [players=2000] [days=300] [targetKeep=0.5]
// Goal: pay players back part of what they lose, while the house keeps >= targetKeep of every
// day's gross gaming revenue (GGR = stakes - payouts) and the rebate itself never turns a day negative.
import { GAMES, evaluate, rtp } from '../server/games.js';

const PLAYERS = +process.argv[2] || 2000, DAYS = +process.argv[3] || 300, KEEP = +process.argv[4] || 0.5;
const pct = x => (100 * x).toFixed(2) + '%', rand$ = x => 'R' + Math.round(x).toLocaleString('en-ZA');

/* ---- population assumptions (edit these to match your real traffic) ---- */
const SPINS = [[20, .30], [40, .30], [80, .20], [150, .15], [300, .05]];     // spins per player per day
const STAKES = [[5, .35], [10, .30], [20, .20], [50, .10], [100, .05]];      // rand per spin
const TIERS = [[500, 1], [2000, 1.5], [Infinity, 2]];                         // net-loss band upper limit (R), rate multiplier

/* ---- fast seeded RNG (xorshift32) ---- */
let s = 0x9e3779b9; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const pick = tbl => { let r = rnd(), a = 0; for (const [v, p] of tbl) { a += p; if (r < a) return v; } return tbl.at(-1)[0]; };

/* ---- per-game maths (exact, by enumeration) ---- */
const info = GAMES.map(g => {
  const W = g.weights.reduce((x, y) => x + y, 0); let m2 = 0, lose = 0;
  for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) for (let c = 0; c < 6; c++) {
    const p = g.weights[a] * g.weights[b] * g.weights[c] / W ** 3, { mult } = evaluate(g, [a, b, c]); m2 += p * mult * mult; if (mult < 1) lose += p;
  }
  const r = rtp(g).rtp; return { id: g.id, edge: 1 - r, rtp: r, sd: Math.sqrt(m2 - r * r), lose };
});
console.log('\n=== 1. House edge per game (exact) ===');
console.log('game    edge   P(spin returns < stake)  per-spin std dev   spins/day for <1% loss-day risk');
for (const i of info) console.log(i.id.padEnd(7), pct(i.edge).padStart(6), pct(i.lose).padStart(14), (i.sd.toFixed(2) + '×stake').padStart(22), String(Math.ceil((2.326 * i.sd / i.edge) ** 2)).padStart(16));
const avgEdge = info.reduce((a, i) => a + i.edge, 0) / info.length;
console.log(`average casino edge ${pct(avgEdge)}; sports edge ${pct(1 - 1 / 1.06)} (6% margin).`);
console.log(`=> keeping ${pct(KEEP)} of GGR leaves a TOTAL rebate budget of only ~${pct(avgEdge * (1 - KEEP))} of all money staked.`);

/* ---- Monte-Carlo days ---- */
const fns = GAMES.map(g => { const W = g.weights.reduce((x, y) => x + y, 0), cum = []; let a = 0; g.weights.forEach(w => cum.push(a += w)); const sym = () => { const r = rnd() * W; for (let i = 0; i < 6; i++) if (r < cum[i]) return i; return 5; }; return () => evaluate(g, [sym(), sym(), sym()]).mult; });
function oneDay() {
  const losses = []; let ggr = 0, turnover = 0;
  for (let p = 0; p < PLAYERS; p++) {
    const n = pick(SPINS), st = pick(STAKES), f = fns[Math.floor(rnd() * fns.length)]; let net = 0;
    for (let k = 0; k < n; k++) net += st * (1 - f());
    ggr += net; turnover += n * st; if (net > 0) losses.push(net);
  }
  return { ggr, turnover, losses };
}
const tierRebate = (L, a) => { let r = 0, lo = 0; for (const [hi, m] of TIERS) { if (L > lo) r += (Math.min(L, hi) - lo) * a * m; lo = hi; } return r; };
const days = Array.from({ length: DAYS }, oneDay);
const mean = f => days.reduce((x, d) => x + f(d), 0) / DAYS;
const eGGR = mean(d => d.ggr), eTurn = mean(d => d.turnover), eLoss = mean(d => d.losses.reduce((x, y) => x + y, 0));

// calibrate flat rate r and tier base 'a' so the AVERAGE rebate = (1-KEEP) x average GGR
const budget = (1 - KEEP) * eGGR, flatRate = budget / eLoss;
let lo = 0, hi = 1; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; (mean(d => d.losses.reduce((x, L) => x + tierRebate(L, m), 0)) < budget ? lo = m : hi = m); } const tierA = lo;

function report(name, payFn) {
  let loss = 0, short = 0, worst = Infinity, reb = 0, prof = 0, ks = 0, full = 0, pos = 0;
  for (const d of days) {
    const { paid, k } = payFn(d), profit = d.ggr - paid; reb += paid; prof += profit; if (profit < 0) loss++; worst = Math.min(worst, profit);
    if (d.ggr > 0) { pos++; if (profit < KEEP * d.ggr - 1e-6) short++; } if (k !== undefined) { ks += k; if (k >= 0.999) full++; }
  }
  console.log(name.padEnd(34), String(pct(loss / DAYS)).padStart(8), String(pct(pos ? short / pos : 0)).padStart(11), rand$(prof / DAYS).padStart(10), rand$(reb / DAYS).padStart(10), rand$(worst).padStart(11), k0(ks, full));
}
const k0 = (ks, full) => ks ? `  avg k=${(ks / DAYS).toFixed(2)}, promise fully paid ${pct(full / DAYS)} of days` : '';

console.log(`\n=== 2. Simulated days: ${PLAYERS} players/day, ${DAYS} days, avg turnover ${rand$(eTurn)}/day, avg GGR ${rand$(eGGR)}/day (${pct(eGGR / eTurn)}) ===`);
console.log('policy                            P(loss day)  P(keep<50%) avg profit  avg rebate  worst day');
report('no cashback', d => ({ paid: 0 }));
report(`A. flat ${pct(flatRate)} of net loss`, d => ({ paid: flatRate * d.losses.reduce((x, y) => x + y, 0) }));
report(`B. tiered (base ${pct(tierA)}, 1×/1.5×/2×)`, d => ({ paid: d.losses.reduce((x, L) => x + tierRebate(L, tierA), 0) }));
// C: promise a schedule, but fund it only from the day's real result. How big can the promise be
// while still being paid IN FULL on most days?  a_day = the largest base rate the day's pool could fully fund.
const aDay = days.map(d => { const unit = d.losses.reduce((x, L) => x + tierRebate(L, 1), 0); return unit ? Math.max(0, d.ggr) * (1 - KEEP) / unit : 0; }).sort((x, y) => x - y);
const promiseFor = cov => aDay[Math.floor((1 - cov) * (DAYS - 1))];
console.log(`\nPromise level that can be paid IN FULL on X% of days (base rate; tiers are 1x / 1.5x / 2x of it):`);
for (const cov of [0.9, 0.75, 0.5]) console.log(`  ${String(cov * 100).padStart(3)}% of days: ${pct(promiseFor(cov))}  -> R0-R500 ${pct(promiseFor(cov))}, R500-R2000 ${pct(promiseFor(cov) * 1.5)}, R2000+ ${pct(promiseFor(cov) * 2)}`);
const nominal = promiseFor(0.75) || promiseFor(0.5);
report(`C. DYNAMIC: promise ${pct(nominal)}/${pct(nominal * 1.5)}/${pct(nominal * 2)}`, d => {
  const raw = d.losses.reduce((x, L) => x + tierRebate(L, nominal), 0), pool = Math.max(0, d.ggr) * (1 - KEEP), k = raw ? Math.min(1, pool / raw) : 1;
  return { paid: raw * k, k };
});
console.log(`\nA/B pay the same fixed schedule every day, so a lucky-player day makes the rebate deepen the loss.`);
console.log(`C pays  min(promised rebate, ${pct(1 - KEEP)} of that day's positive GGR): it can never push a day below ${pct(KEEP)} of GGR.`);
