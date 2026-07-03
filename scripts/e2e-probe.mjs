// One-off visual probe: load a location, wait for tiles, take an aerial shot.
// Usage: node scripts/e2e-probe.mjs <shots-dir> <lat> <lon> <name> [height] [pitch]
import puppeteer from 'puppeteer-core';

const SHOT_DIR = process.argv[2] ?? '.';
const lat = process.argv[3];
const lon = process.argv[4];
const name = process.argv[5] ?? 'probe';
const height = parseFloat(process.argv[6] ?? '450');
const pitch = parseFloat(process.argv[7] ?? '-1.15');

const browser = await puppeteer.launch({
  executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  headless: 'new',
  userDataDir: process.env.E2E_PROFILE ?? '/tmp/twinio-e2e-profile',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 900 },
});

const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:4188/?lat=${lat}&lon=${lon}&v=${Date.now()}`, {
  waitUntil: 'load',
  timeout: 60000,
});
console.log('BUNDLE::' + (await page.$eval('script[type=module]', (s) => s.src)));

const deadline = Date.now() + 150000;
while (Date.now() < deadline) {
  const stats = await page.$eval('#hud-stats', (el) => el.textContent);
  const m = stats.match(/Karolar: (\d+)/);
  if (m && parseInt(m[1]) >= 9 && !/\+\d+ yükleniyor/.test(stats)) break;
  await new Promise((r) => setTimeout(r, 3000));
}
await new Promise((r) => setTimeout(r, 5000));

await page.evaluate((h, p) => window.__twinio.place(0, h, h * 0.25, p, 0), height, pitch);
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
console.log('PAGEERRORS::' + JSON.stringify(errors));
await browser.close();
process.exit(0);
