// Apex Games: six animal-themed 3-reel instant games. Every round is decided on the server with a CSPRNG.
// Win rules (first match wins):
//   1. three of a kind             -> pay3[symbol]
//   2. first two reels match       -> pay2[symbol]
//   3. the animal symbol anywhere  -> pay1
// Paytables were tuned so each game returns ~95% (see test/games.test.js, which recomputes RTP exactly).
import { randomInt } from 'node:crypto';

const COMMON = ['💎', '👑', '🔔', '🍀', '⭐'];
const game = (id, name, animal, tagline, volatility, w, pay3, pay2, pay1) =>
  ({ id, name, animal, tagline, volatility, symbols: [animal, ...COMMON], weights: w, pay3, pay2, pay1 });

export const GAMES = [
  game('lion', 'Lion’s Pride', '🦁', 'Rule the savannah – the king pays up to 136×.', 'Medium',
    [2, 3, 4, 4, 5, 6], [136, 31, 13, 13, 7, 3.9], [2.8, 1.9, 1.5, 1.9, 1.5, 1.3], 1.6),
  game('tiger', 'Tiger Stripes', '🐯', 'Fast, fierce and streaky – up to 236×.', 'Medium-High',
    [2, 3, 4, 4, 5, 6], [236, 37, 14, 12, 6, 3.5], [4.3, 2, 1.6, 2, 1.3, 1.2], 1.4),
  game('bear', 'Grizzly Gold', '🐻', 'Steady wins and frequent hits – low volatility.', 'Low',
    [3, 3, 4, 4, 5, 5], [23, 23, 11.5, 11.5, 6, 6], [1.3, 2, 1.6, 1.9, 1.6, 1.8], 1.4),
  game('eagle', 'Eagle Eye', '🦅', 'Spot the prize from above – up to 138×.', 'Medium',
    [2, 3, 3, 4, 5, 6], [138, 33, 29, 12, 6, 3.6], [2.6, 1.8, 2.5, 1.8, 1.5, 1.3], 1.3),
  game('wolf', 'Wolf Pack', '🐺', 'Hunt with the pack for a 565× howler.', 'High',
    [3, 6, 7, 8, 9, 9], [565, 29, 14, 8, 4.8, 4.8], [8, 1.6, 1.2, 1.3, 1.3, 1.3], 1.2),
  game('shark', 'Shark Frenzy', '🦈', 'Dive into the deep – up to 844× on a feeding frenzy.', 'High',
    [3, 6, 7, 8, 9, 10], [844, 32, 15.5, 7.5, 5, 3], [8.5, 1.7, 1.3, 1, 1.1, 0.9], 1),
];
export const gameById = id => GAMES.find(g => g.id === id);

// Evaluate one outcome (array of 3 symbol indexes) -> {mult, win:'three'|'pair'|'animal'|null}
export function evaluate(g, [a, b, c]) {
  if (a === b && b === c) return { mult: g.pay3[a], win: 'three' };
  if (a === b) return { mult: g.pay2[a], win: 'pair' };
  if (a === 0 || b === 0 || c === 0) return { mult: g.pay1, win: 'animal' };
  return { mult: 0, win: null };
}

function pickSymbol(g) {
  const total = g.weights.reduce((x, y) => x + y, 0);
  let r = randomInt(total);
  for (let i = 0; i < g.weights.length; i++) { if (r < g.weights[i]) return i; r -= g.weights[i]; }
}
export const spin = g => [pickSymbol(g), pickSymbol(g), pickSymbol(g)];

// Exact return-to-player by enumerating all 216 outcomes.
export function rtp(g) {
  const W = g.weights.reduce((x, y) => x + y, 0); let sum = 0, hits = 0;
  for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) for (let c = 0; c < 6; c++) {
    const p = g.weights[a] * g.weights[b] * g.weights[c] / W ** 3, { mult } = evaluate(g, [a, b, c]);
    sum += p * mult; if (mult) hits += p;
  }
  return { rtp: sum, hitRate: hits };
}

export const publicGame = g => ({ id: g.id, name: g.name, animal: g.animal, tagline: g.tagline, volatility: g.volatility,
  symbols: g.symbols, image: `/img/${g.id}.png`, rtp: Math.round(rtp(g).rtp * 1000) / 10, pay3: g.pay3, pay2: g.pay2, pay1: g.pay1 });
