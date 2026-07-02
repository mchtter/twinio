// Smoke test: verifies the built app boots, streams tiles and renders.
// Usage: npm i --no-save puppeteer-core && npm run preview -- --port 4188 & node scripts/e2e-smoke.mjs <shots-dir> [url]
// Requires a Chromium-based browser; path below targets Microsoft Edge on macOS.
import puppeteer from 'puppeteer-core';

const SHOT_DIR = process.argv[2] ?? '.';
const URL = process.argv[3] ?? 'http://localhost:4188/?lat=40.9887&lon=29.0253';

const browser = await puppeteer.launch({
  executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  headless: 'new',
  userDataDir: process.env.E2E_PROFILE ?? '/tmp/twinio-e2e-profile',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 900 },
});

const page = await browser.newPage();
const errors = [];
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });

const deadline = Date.now() + 180000;
let stats = '';
while (Date.now() < deadline) {
  stats = await page.$eval('#hud-stats', (el) => el.textContent);
  const m = stats.match(/Karolar: (\d+)/);
  if (m && parseInt(m[1]) >= 9 && !/\+\d+ yükleniyor/.test(stats)) break;
  await new Promise((r) => setTimeout(r, 3000));
}
await new Promise((r) => setTimeout(r, 6000));

// aerial day
await page.evaluate(() => window.__twinio.place(0, 620, 150, -1.2, 0));
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: `${SHOT_DIR}/world-aerial.png` });

// street level
await page.evaluate(() => window.__twinio.place(40, 70, 40, -0.85, 0.6));
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${SHOT_DIR}/world-street.png` });

// night aerial
await page.evaluate(() => {
  window.__twinio.setHour(22);
  window.__twinio.place(0, 450, 150, -1.15, 0);
});
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${SHOT_DIR}/world-night.png` });

stats = await page.$eval('#hud-stats', (el) => el.textContent);
console.log('STATS::' + stats.replace(/\n/g, ' | '));
console.log('PAGEERRORS::' + JSON.stringify(errors));
console.log('WARNLOGS::' + JSON.stringify(logs.filter((l) => !l.includes('429') && !l.includes('504') && !l.includes('Too Many')).slice(0, 10)));

await browser.close();
process.exit(0);
