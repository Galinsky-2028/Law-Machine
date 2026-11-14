import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * LM-055 page measurements against a running production server (default
 * http://localhost:3000). Phone profile: 390x844, 4x CPU slowdown and a
 * throttled 1.6 Mbps / 150 ms link. Desktop: no throttling. Warm server.
 */
const base = process.env.LM_PERF_URL ?? 'http://localhost:3000';
const path = '/packs/meridian-claims/scenarios/wrong-agency';
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
const results = {};
for (const [name, profile] of [['desktop', { viewport: { width: 1366, height: 900 } }], ['phone', { viewport: { width: 390, height: 844 }, throttle: true }]]) {
  const context = await browser.newContext({ viewport: profile.viewport });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (profile.throttle) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 90000 });
  }
  await page.addInitScript(() => {
    window.__lcp = 0; window.__cls = 0;
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(base + path, { waitUntil: 'load' });
  const t0 = Date.now();
  await page.getByText(/Verified & signed|Integrity verified/).waitFor({ timeout: 60000 });
  const interactiveAfterLoadMs = Date.now() - t0;
  // Interaction latency: time from a click on "Compare both" to the comparison table being rendered.
  const i0 = Date.now();
  await page.getByRole('radio', { name: 'Compare both' }).check();
  await page.getByRole('row', { name: /Presentment/ }).waitFor();
  const compareInteractionMs = Date.now() - i0;
  const metrics = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource');
    const js = entries.filter(e => e.initiatorType === 'script' || e.name.endsWith('.js'));
    return { lcpMs: Math.round(window.__lcp), cls: Math.round(window.__cls * 1000) / 1000,
      transferredKB: Math.round(entries.reduce((n, e) => n + (e.transferSize || 0), 0) / 1024),
      scriptKB: Math.round(js.reduce((n, e) => n + (e.transferSize || 0), 0) / 1024),
      releaseKB: Math.round(entries.filter(e => e.name.includes('/releases/')).reduce((n, e) => n + (e.transferSize || 0), 0) / 1024) };
  });
  results[name] = { ...metrics, interactiveAfterLoadMs, compareInteractionMs };
  await context.close();
}
await browser.close();
const report = { measuredAt: new Date().toISOString(), url: path, server: base, note: 'Local production build in a cloud container; Chromium headless. Not field data.', targets: { lcpMs: 2500, cls: 0.1, interactionMs: 200, criticalAssetsKB: 1024 }, results };
console.log(JSON.stringify(report, null, 1));
if (process.argv.includes('--write')) writeFileSync(new URL('../docs/evidence/performance-web.json', import.meta.url), JSON.stringify(report, null, 1) + '\n');
