import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { buildAndVerify } from '../../scripts/packs.ts';
import { exportRun, prepareScenario, runPackScenario } from '../../packages/simulation/src/index.ts';

const scenarioUrl = '/packs/meridian-claims/scenarios/';
async function ready(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByText(/Verified & signed|Integrity verified/)).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Step by step' })).toBeVisible();
}
const axe = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map(v => v.id + ': ' + v.nodes.map(n => n.target.join(' ')).slice(0, 4).join(' | '))).toEqual([]);
};

test('home lists signed fictional models and the unavailable real bill honestly', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('See how a law works.');
  await expect(page.getByRole('link', { name: 'Claims and the wrong agency (fictional)' })).toBeVisible();
  await expect(page.getByText('Federal electronic-filing bill: not available yet.')).toBeVisible();
  await axe(page);
});

test('wrong-agency journey: verified release, keyboard map, sources behind each step', async ({ page }) => {
  await ready(page, scenarioUrl + 'wrong-agency');
  await expect(page.getByText('Fictional law', { exact: true })).toBeVisible();
  await expect(page.getByText('Hypothetical scenario', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next ▶' }).click();
  await page.getByRole('button', { name: /treated as received by the responsible agency at the original receipt time/ }).click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('link', { name: '§ 4(b)' })).toBeVisible();
  await expect(inspector.locator('mark').filter({ hasText: 'treated as received by the responsible agency' })).toBeVisible();
  // Keyboard: focus a map institution and inspect it with Enter.
  const roads = page.locator('[data-actor="dept-roads"]');
  await roads.focus();
  await page.keyboard.press('Enter');
  await expect(inspector.getByRole('heading', { name: 'Department of Roads', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-actor="dept-parks"]')).toBeFocused();
  await page.getByRole('button', { name: 'Jump to outcome' }).click();
  await expect(page.getByRole('heading', { name: /Outcome under/ })).toBeVisible();
  await axe(page);
});

test('comparison changes only the framework and explains the date difference', async ({ page }) => {
  await ready(page, scenarioUrl + 'wrong-agency');
  await page.getByRole('radio', { name: 'Compare both' }).check();
  const table = page.getByRole('table').first();
  const row = table.getByRole('row', { name: /Presentment/ });
  await expect(row).toContainText('Tue, Mar 2, 2027');
  await expect(row).toContainText('Mon, Mar 1, 2027');
  await expect(page.getByText('Same hypothetical facts and the same behavior assumptions under both.')).toBeVisible();
  await axe(page);
});

test('changing a circumstance validates input, records a breach and survives a shared link', async ({ page }) => {
  await ready(page, scenarioUrl + 'wrong-agency');
  const delay = page.getByLabel(/Days the wrong agency takes to forward the claim/);
  await delay.fill('99');
  await expect(page.getByRole('alert').filter({ hasText: 'must be a whole number from 0 to 30' })).toBeVisible();
  await delay.fill('5');
  await expect(page.getByText('Your experiment — not the published scenario')).toBeVisible();
  await page.getByRole('button', { name: 'Jump to outcome' }).click();
  await expect(page.locator('.outcome')).toContainText('Breached');
  await expect(page).toHaveURL(/p\.transfer-delay=5/);
  await expect(page).toHaveURL(/r=[a-f0-9]{64}/);
  await page.reload();
  await expect(page.getByLabel(/Days the wrong agency takes to forward the claim/)).toHaveValue('5', { timeout: 30000 });
  await page.getByRole('button', { name: 'Reset to the published scenario' }).click();
  await expect(page.getByLabel(/Days the wrong agency takes to forward the claim/)).toHaveValue('1');
});

test('a sandbox rule edit is labeled and cannot be shared or exported as the published model', async ({ page }) => {
  await ready(page, scenarioUrl + 'missed-routing');
  await page.getByText('Experiment: switch off a rule').click();
  await page.getByRole('checkbox', { name: /The wrong agency must route the claim within 2 business days/ }).uncheck();
  await expect(page.getByText(/Modified model\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy a link to this run' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download as JSON' })).toBeDisabled();
});

test('unknown or tampered release links are refused instead of substituted', async ({ page }) => {
  await page.goto(scenarioUrl + 'wrong-agency?r=' + '0'.repeat(64));
  await expect(page.getByRole('alert').filter({ hasText: 'not available' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('link', { name: 'Open this scenario in the current release' })).toBeVisible();
});

test('an unresolved interpretation stays visible until a reading is chosen', async ({ page }) => {
  await ready(page, scenarioUrl + 'missing-amount');
  await page.getByRole('button', { name: 'Jump to outcome' }).click();
  await expect(page.locator('.outcome .unresolved-note')).toBeVisible();
  await page.getByLabel('Reading of § 5(b) and § 5(c)').selectOption('relation-back');
  await page.getByRole('button', { name: 'Jump to outcome' }).click();
  await expect(page.locator('.outcome .unresolved-note')).toHaveCount(0);
});

test('guided tour focuses sources and returns the visitor to their place', async ({ page }) => {
  await ready(page, scenarioUrl + 'wrong-agency');
  await page.getByRole('button', { name: 'Next ▶' }).click();
  const before = await page.getByRole('slider').inputValue();
  await page.getByRole('button', { name: 'Take the guided tour' }).click();
  await expect(page.getByRole('heading', { name: 'The claim goes to the wrong agency' })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: '§ 4(b)' })).toBeVisible();
  await page.getByRole('button', { name: 'Leave the tour and return to where I was' }).click();
  await expect(page.getByRole('slider')).toHaveValue(before);
});

test('phone layout: step list first, map on request, no horizontal scroll, reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page, scenarioUrl + 'wrong-agency');
  await expect(page.locator('.scene-map')).toBeHidden();
  await page.getByRole('button', { name: 'Map' }).click();
  await expect(page.locator('.scene-map')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await axe(page);
});

test('source explorer, glossary and search find concepts without section numbers', async ({ page }) => {
  await page.goto('/packs/meridian-claims/sources/claims-act#s4.b');
  await expect(page.locator('#s4\\.b')).toContainText('treated as received by the responsible agency');
  await expect(page.locator('#s3\\.b')).toContainText('Ambiguous');
  await axe(page);
  await page.goto('/search');
  await page.getByLabel('Search for').fill('wrong agency');
  await expect(page.getByRole('link', { name: 'Routing', exact: true })).toBeVisible();
  await page.getByLabel('Search for').fill('denial');
  await expect(page.getByRole('link', { name: 'Treat as denied' })).toBeVisible();
  await axe(page);
  await page.goto('/packs/meridian-claims/glossary');
  await expect(page.locator('dt', { hasText: 'Presentment' })).toBeVisible();
  await axe(page);
});

test('stress view runs bounded seeded samples with methodology', async ({ page }) => {
  await page.goto('/packs/meridian-claims/stress');
  await page.getByLabel('Number of runs').fill('30');
  await page.getByRole('button', { name: 'Run stress test' }).click();
  await expect(page.getByRole('heading', { name: 'Timeliness across 30 runs' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(/not a prediction for any real agency/)).toBeVisible();
  await axe(page);
});

test('server recomputes exports: genuine verifies, forged fails, public API is cache-safe', async ({ request }) => {
  const built = await buildAndVerify('meridian-claims');
  const release = built.built.release!, digest = built.built.manifestDigest!;
  const p = prepareScenario(release, 'missed-routing');
  const exported = await exportRun(release, built.built.manifest!.releaseId, digest, p, runPackScenario(p.release, 'proposal', p.scenario));
  const ok = await request.post('/api/v1/runs/verify', { data: exported });
  expect(await ok.json()).toMatchObject({ valid: true, reason: 'RECOMPUTED_MATCH' });
  const forged = JSON.parse(JSON.stringify(exported));
  forged.summary.duties[0].state = 'satisfied';
  expect(await (await request.post('/api/v1/runs/verify', { data: forged })).json()).toMatchObject({ valid: false, reason: 'OUTCOME_MISMATCH' });
  expect((await request.post('/api/v1/runs/verify', { data: 'not json' })).status()).toBe(400);
  const catalog = await request.get('/api/v1/catalog');
  expect((await catalog.json()).packs.length).toBe(3);
  const manifest = await request.get('/api/v1/packs/meridian-claims/releases/' + digest);
  expect(manifest.headers()['cache-control']).toContain('immutable');
  expect((await request.get('/api/v1/packs/meridian-claims/releases/' + '0'.repeat(64))).status()).toBe(404);
  const provision = await request.get('/api/v1/provisions/meridian-act-draft-1/s4.a');
  expect((await provision.json()).provision.citation).toBe('§ 4(a)');
});
