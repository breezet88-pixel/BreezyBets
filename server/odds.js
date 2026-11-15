// Server-side odds engine (sample data + simulated movement).
// In production this is replaced by a licensed odds/results feed and a trading/risk engine.
export const MARGIN = 0.06;
// True win chance behind a displayed price. Odds contain the margin, so 1/odds over-states it by (1+MARGIN).
export const winProbability = odds => 1 / (odds * (1 + MARGIN));
export const oddsFrom = p => Math.max(1.01, Math.round(100 / (p * (1 + MARGIN))) / 100);

const RAW = [
  ['soccer', 'South Africa – Premiership (PSL)', 'Kaizer Chiefs', 'Orlando Pirates', -0.6, [.30, .28, .42], true],
  ['soccer', 'South Africa – Premiership (PSL)', 'Mamelodi Sundowns', 'Stellenbosch FC', 3, [.62, .22, .16]],
  ['soccer', 'South Africa – Premiership (PSL)', 'SuperSport United', 'Cape Town City', 5, [.38, .30, .32]],
  ['soccer', 'South Africa – Premiership (PSL)', 'AmaZulu', 'Royal AM', 27, [.45, .28, .27]],
  ['soccer', 'South Africa – Premiership (PSL)', 'Sekhukhune United', 'Richards Bay', 29, [.44, .29, .27]],
  ['soccer', 'England – Premier League', 'Arsenal', 'Liverpool', 7, [.42, .27, .31]],
  ['soccer', 'England – Premier League', 'Manchester City', 'Chelsea', 8, [.58, .23, .19]],
  ['soccer', 'Spain – La Liga', 'Real Madrid', 'FC Barcelona', 30, [.40, .25, .35]],
  ['rugby', 'United Rugby Championship', 'Stormers', 'Leinster', -0.4, [.38, null, .62], true],
  ['rugby', 'United Rugby Championship', 'Bulls', 'Munster', 4, [.60, null, .40]],
  ['rugby', 'United Rugby Championship', 'Sharks', 'Glasgow Warriors', 28, [.55, null, .45]],
  ['rugby', 'Rugby Championship', 'South Africa', 'New Zealand', 52, [.48, null, .52]],
  ['cricket', 'SA20', 'MI Cape Town', 'Joburg Super Kings', 6, [.50, null, .50]],
  ['cricket', 'SA20', 'Pretoria Capitals', 'Paarl Royals', 30, [.47, null, .53]],
  ['cricket', 'SA20', 'Sunrisers Eastern Cape', 'Durban’s Super Giants', 54, [.58, null, .42]],
  ['tennis', 'ATP Tour', 'Carlos Alcaraz', 'Jannik Sinner', 9, [.49, null, .51]],
  ['tennis', 'WTA Tour', 'Iga Świątek', 'Aryna Sabalenka', 10, [.52, null, .48]],
  ['basketball', 'NBA', 'Boston Celtics', 'Denver Nuggets', 11, [.55, null, .45]],
  ['basketball', 'NBA', 'LA Lakers', 'Golden State Warriors', 12, [.46, null, .54]],
];

export function createOddsEngine(now = Date.now()) {
  const maxMin = sport => (sport === 'rugby' ? 80 : 90);
  const events = RAW.map(([sport, league, home, away, h, p, live], i) => ({
    id: 'e' + i, sport, league, home, away, start: now + h * 36e5, live: !!live, p: p.slice(),
    score: live ? [sport === 'rugby' ? 14 : 1, sport === 'rugby' ? 17 : 1] : null,
    minute: live ? (sport === 'rugby' ? 52 : 63) : 0,
    ou: sport === 'soccer' ? 0.52 : null,
  }));

  const isClosed = e => e.live && e.minute >= maxMin(e.sport); // full time: no more betting
  function markets(e) {
    const hasDraw = e.p[1] != null;
    const m = [{ key: 'w', name: hasDraw ? 'Match Result' : 'Match Winner', sels: [
      { k: 'h', label: e.home, short: '1', odds: oddsFrom(e.p[0]) },
      ...(hasDraw ? [{ k: 'd', label: 'Draw', short: 'X', odds: oddsFrom(e.p[1]) }] : []),
      { k: 'a', label: e.away, short: '2', odds: oddsFrom(e.p[2]) }] }];
    if (e.ou != null) m.push({ key: 'ou', name: 'Total Goals 2.5', sels: [
      { k: 'o', label: 'Over 2.5', short: 'O', odds: oddsFrom(e.ou) },
      { k: 'u', label: 'Under 2.5', short: 'U', odds: oddsFrom(1 - e.ou) }] });
    return m;
  }

  return {
    snapshot: () => events.map(e => ({
      id: e.id, sport: e.sport, league: e.league, home: e.home, away: e.away, start: e.start,
      live: e.live, closed: isClosed(e), score: e.score && e.score.slice(), minute: e.minute, markets: markets(e),
    })),
    // Resolve a selection against CURRENT odds; null if unknown or not open for betting.
    lookup(evId, mk, k) {
      const e = events.find(x => x.id === evId); if (!e) return null;
      if (isClosed(e) || (!e.live && e.start <= Date.now())) return null;
      const m = markets(e).find(x => x.key === mk); const s = m && m.sels.find(x => x.k === k);
      return s ? { odds: s.odds, label: s.label, market: m.name, match: `${e.home} v ${e.away}` } : null;
    },
    tick() {
      for (const e of events) {
        if (e.live && !isClosed(e)) {
          e.minute += 1;
          if (Math.random() < .08 && e.score) e.score[Math.random() < .5 ? 0 : 1] += e.sport === 'rugby' ? (Math.random() < .5 ? 7 : 3) : 1;
        }
        const j = e.live ? .03 : .008, sh = (Math.random() - .5) * j;
        e.p[0] = Math.min(.9, Math.max(.05, e.p[0] + sh));
        if (e.p[1] != null) { e.p[1] = Math.min(.5, Math.max(.08, e.p[1] - sh / 2)); e.p[2] = Math.max(.05, 1 - e.p[0] - e.p[1]); }
        else e.p[2] = 1 - e.p[0];
        if (e.ou != null) e.ou = Math.min(.8, Math.max(.2, e.ou + (Math.random() - .5) * j));
      }
    },
  };
}
