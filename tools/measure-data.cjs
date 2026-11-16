// How much mobile data does the site really use?
// This counts every byte that crosses the network socket in both directions: requests, responses, headers and,
// for HTTPS, the encryption overhead. (TCP/IP packet headers are not included.)
//
//   node tools/measure-data.cjs [--app <checkout dir>] [--seconds 60]
//
// Needs Playwright. The "HTTPS + HTTP/2" run, which is how a production site is served, also needs openssl.
// A fresh server is started for every measurement so the sample live matches are always mid-game.
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('node:child_process');
const net = require('node:net'), http = require('node:http'), http2 = require('node:http2');
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const APP = path.resolve(arg('app', path.join(__dirname, '..'))), SECONDS = Number(arg('seconds', 60));
const SCENARIOS = [
  ['cricket', 'A sport with no live match (Cricket)', '#/sports/cricket', '.ev'],
  ['soccer', 'A sport with one live match on screen (Soccer)', '#/sports/soccer', '.ev'],
  ['live', 'The Live tab (two live matches)', '#/sports/live', '.ev'],
  ['mybets', 'My Bets, empty bet slip', '#/my-bets', '.empty'],
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-data-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const listen = server => new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
const freePort = async () => { const s = net.createServer(); const p = await listen(s); await new Promise(r => s.close(r)); return p; };

async function startApp() {
  const port = await freePort();
  const proc = spawn('node', ['--disable-warning=ExperimentalWarning', path.join(APP, 'server/server.js')],
    { env: { ...process.env, PORT: String(port), DB_PATH: path.join(tmp, `m${port}.db`) }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {                                 // wait until it answers
    const up = await new Promise(ok => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); ok(true); }); s.on('error', () => ok(false)); });
    if (up) return { port, stop: () => proc.kill() };
    await sleep(50);
  }
  proc.kill(); throw new Error('the app did not start');
}

// Sits between the browser and the server and counts what goes through.
async function startCounter(targetPort) {
  const c = { up: 0, down: 0 };
  const server = net.createServer(client => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    client.on('data', d => { c.up += d.length; }); upstream.on('data', d => { c.down += d.length; });
    client.pipe(upstream); upstream.pipe(client);
    const end = () => { client.destroy(); upstream.destroy(); }; client.on('error', end); upstream.on('error', end);
  });
  const port = await listen(server);
  return { port, take: () => { const t = { up: c.up, down: c.down, total: c.up + c.down }; c.up = c.down = 0; return t; }, stop: () => server.close() };
}

// Production-style front door: HTTPS with HTTP/2, passing requests on to the app.
async function startHttps(appPort) {
  const key = path.join(tmp, 'key.pem'), cert = path.join(tmp, 'cert.pem');
  if (!fs.existsSync(key)) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-days', '2', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const server = http2.createSecureServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), allowHTTP1: true });
  server.on('request', (req, res) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith(':')));
    headers.host = `127.0.0.1:${appPort}`;
    const up = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers }, r => {
      const out = { ...r.headers }; for (const k of ['connection', 'keep-alive', 'transfer-encoding']) delete out[k];
      res.writeHead(r.statusCode, out); r.pipe(res);
    });
    up.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
  server.on('error', () => {});
  return { port: await listen(server), stop: () => server.close() };
}

async function measure(browser, mode, [key, , hash, ready]) {
  const app = await startApp(), front = mode === 'h2' ? await startHttps(app.port) : null, counter = await startCounter(front ? front.port : app.port);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, ignoreHTTPSErrors: true }), page = await ctx.newPage();
  try {
    await page.goto(`${mode === 'h2' ? 'https' : 'http'}://localhost:${counter.port}/${hash}`);
    await page.waitForSelector(ready); await page.waitForLoadState('networkidle');
    const protocol = await page.evaluate(() => performance.getEntriesByType('navigation')[0].nextHopProtocol);
    const first = counter.take();
    await page.waitForTimeout(SECONDS * 1000);
    const used = counter.take();
    return { key, protocol, first_visit_bytes: first.total, bytes: used.total, up: used.up, down: used.down, mb_per_hour: used.total * 3600 / SECONDS / 1e6 };
  } finally { await ctx.close(); counter.stop(); if (front) front.stop(); app.stop(); }
}

(async () => {
  const browser = await chromium.launch(); const out = { app: APP, seconds: SECONDS, modes: {} };
  let openssl = true; try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { openssl = false; }
  for (const [mode, label] of [['h1', 'Plain HTTP/1.1 (how the app runs on its own)'], ...(openssl ? [['h2', 'HTTPS + HTTP/2 (how a production site is served)']] : [])]) {
    console.log(`\n${label}`); out.modes[mode] = {};
    for (const sc of SCENARIOS) {
      const r = await measure(browser, mode, sc); out.modes[mode][r.key] = r;
      console.log(`  ${sc[1].padEnd(48)} ${r.mb_per_hour.toFixed(2).padStart(5)} MB per hour   (first visit ${(r.first_visit_bytes / 1000).toFixed(1)} KB, ${r.protocol})`);
    }
  }
  if (!openssl) console.log('\nopenssl not found: skipped the HTTPS + HTTP/2 run.');
  console.log('\n' + JSON.stringify(out));
  await browser.close(); fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
