import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('credential-free public site and health route work', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('See how a law works.');
  await expect(page.getByText('It does not accept filings, issue receipts', { exact: false })).toBeVisible();
  const health = await (await request.get('/api/health')).json();
  expect(health).toMatchObject({ status: 'ok', simulationAvailable: true, filingsAccepted: false });
  expect(health.publishedPacks).toBeGreaterThan(0);
  expect(JSON.stringify(health)).not.toMatch(/postgres(ql)?:\/\/|password|secret/i);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
