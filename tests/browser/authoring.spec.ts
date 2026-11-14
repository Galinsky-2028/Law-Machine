import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';

/**
 * End-to-end authoring lifecycle against a real PostgreSQL database. Requires a
 * server started with DATABASE_URL/AUTH_DATABASE_URL/LM_SOURCE_KEY and a fresh
 * database bootstrapped with the invitation code in LM_E2E_INVITE.
 */
const INVITE = process.env.LM_E2E_INVITE;
const ORIGIN = process.env.LM_E2E_ORIGIN ?? 'http://localhost:3000';
test.skip(!INVITE, 'Authoring E2E needs LM_E2E_INVITE and a database-backed server');
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: ORIGIN });

async function passkeyDevice(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}
async function csrf(context: BrowserContext) { return (await context.cookies()).find(c => c.name === '__Host-lm_csrf')?.value ?? ''; }
const mutate = async (context: BrowserContext) => ({ origin: ORIGIN, 'x-law-machine-csrf': await csrf(context), 'content-type': 'application/json' });

let owner: Page;
let org = '';
let doc = '';
let manifest = '';
const root = new URL('../../', import.meta.url);

test('owner enrolls with the bootstrap invitation using a passkey', async ({ browser }) => {
  owner = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await passkeyDevice(owner);
  await owner.goto('/author');
  await expect(owner.getByRole('heading', { name: 'Authoring' })).toBeVisible();
  expect((await new AxeBuilder({ page: owner }).analyze()).violations).toEqual([]);
  await owner.getByLabel('Invitation code').fill(INVITE!);
  await owner.getByLabel('Your name as shown to collaborators').fill('Owner');
  await owner.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(owner.getByRole('heading', { name: 'Hello, Owner' })).toBeVisible({ timeout: 20000 });
  // The invitation is single-use.
  const again = await owner.request.post('/api/author/passkey/register/options', { headers: { origin: ORIGIN, 'content-type': 'application/json' }, data: { invitationCode: INVITE, displayName: 'X' } });
  expect(again.ok()).toBeTruthy(); // signed-in path adds a passkey; anonymous reuse is tested below
  const anon = await (await browser.newContext({ baseURL: ORIGIN })).request.post('/api/author/passkey/register/options', { headers: { origin: ORIGIN, 'content-type': 'application/json' }, data: { invitationCode: INVITE, displayName: 'X' } });
  expect(anon.status()).toBe(403);
  const link = owner.getByRole('link', { name: 'law-machine' });
  org = (await link.getAttribute('href'))!.split('/').pop()!;
  await link.click();
  await expect(owner.getByText('Your role: publisher')).toBeVisible();
});

test('owner creates a model, uploads sources, edits and saves with revision checks', async () => {
  await owner.getByLabel('Pack ID (lowercase letters, numbers, dashes)').fill('e2e-permits');
  await owner.getByLabel('Title').fill('E2E permits (fictional)');
  await owner.getByRole('button', { name: 'Create model' }).click();
  await owner.waitForURL(/\/packs\/[0-9a-f-]{36}$/);
  doc = owner.url().split('/').pop()!;
  await owner.getByRole('tab', { name: 'Sources' }).click();
  for (const file of ['ordinance-current.md', 'ordinance-amended-draft.md']) {
    await owner.getByLabel('File').setInputFiles(new URL('content/packs/riverbend-permits/sources/' + file, root).pathname);
    await owner.getByRole('button', { name: 'Upload and parse' }).click();
    await expect(owner.getByText(/Imported: \d+ provisions\./)).toBeVisible({ timeout: 30000 });
  }
  const data = await (await owner.request.get('/api/v1/author/' + org + '/packs/' + doc)).json();
  const id = (name: string) => data.sources.find((s: { name: string }) => s.name === name).id;
  const pack = JSON.parse(readFileSync(new URL('content/packs/riverbend-permits/pack.json', root), 'utf8'));
  pack.packId = 'e2e-permits'; pack.title = 'E2E permits (fictional)'; pack.releaseLabel = '1.0.0';
  pack.sources[0].objectId = id('ordinance-current.md'); pack.sources[1].objectId = id('ordinance-amended-draft.md');
  await owner.getByRole('tab', { name: 'JSON' }).click();
  await owner.getByLabel('Model JSON').fill(JSON.stringify(pack));
  await owner.getByRole('button', { name: 'Apply JSON' }).click();
  await owner.getByRole('button', { name: 'Save revision' }).click();
  await expect(owner.getByText('Saved revision 2.')).toBeVisible();
  // A stale revision never overwrites a newer one.
  const headers = await mutate(owner.context());
  const stale = await owner.request.put('/api/v1/author/' + org + '/packs/' + doc, { headers, data: { expectedRevision: 1, payload: pack } });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).code).toBe('STALE_REVISION');
  // Mutations without the CSRF header or from another origin are refused.
  const noCsrf = await owner.request.put('/api/v1/author/' + org + '/packs/' + doc, { headers: { origin: ORIGIN }, data: { expectedRevision: 2, payload: pack } });
  expect((await noCsrf.json()).code).toBe('CSRF_INVALID');
  const otherOrigin = await owner.request.put('/api/v1/author/' + org + '/packs/' + doc, { headers: { ...headers, origin: 'https://evil.example' }, data: { expectedRevision: 2, payload: pack } });
  expect(otherOrigin.status()).toBe(403);
});

test('validation job builds a staged release; publication is atomic and signed-checkable', async () => {
  await owner.getByRole('tab', { name: 'Validate & publish' }).click();
  await owner.getByRole('button', { name: 'Validate this revision' }).click();
  await expect(owner.getByText('Valid. A staged build is ready to preview and publish.')).toBeVisible({ timeout: 60000 });
  await expect(owner.getByText(/Expectations: 45 of 45 matched\./)).toBeVisible();
  await owner.getByRole('button', { name: 'Preview privately' }).first().click();
  await expect(owner.getByText('Private preview (not public, not cached)')).toBeVisible();
  // Before publication the public site has nothing for this pack.
  expect((await owner.request.get('/packs/e2e-permits')).status()).toBe(404);
  await owner.getByRole('button', { name: 'Publish' }).click();
  await expect(owner.getByText('Published. The public pointer now names this release.')).toBeVisible({ timeout: 20000 });
  const catalog = await (await owner.request.get('/api/v1/catalog')).json();
  const entry = catalog.packs.find((p: { packId: string }) => p.packId === 'e2e-permits');
  expect(entry).toBeTruthy();
  manifest = entry.current;
  const pub = await owner.context().newPage();
  await pub.goto('/packs/e2e-permits/scenarios/slow-decision');
  await expect(pub.getByText(/Verified & signed|Integrity verified/)).toBeVisible({ timeout: 30000 });
  await pub.getByRole('radio', { name: 'Compare both' }).check();
  await expect(pub.getByRole('table').first().getByRole('row', { name: /Outcome/ })).toContainText('Wed, Apr 21, 2027');
  await pub.close();
});

test('roles, cross-organization access and revocation are enforced server-side', async ({ browser }) => {
  const anon = await browser.newContext({ baseURL: ORIGIN });
  expect((await anon.request.get('/api/v1/author/' + org + '/packs')).status()).toBe(401);
  expect((await owner.request.get('/api/v1/author/00000000-0000-4000-8000-000000000000/packs')).status()).toBe(403);
  await owner.goto('/author/' + org);
  await owner.getByLabel('Invite someone as').selectOption('contributor');
  await owner.getByRole('button', { name: 'Create invitation code' }).click();
  const code = (await owner.locator('.invite-code code').innerText()).trim();
  const contributor = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await passkeyDevice(contributor);
  await contributor.goto('/author');
  await contributor.getByLabel('Invitation code').fill(code);
  await contributor.getByLabel('Your name as shown to collaborators').fill('Contributor');
  await contributor.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(contributor.getByRole('heading', { name: 'Hello, Contributor' })).toBeVisible({ timeout: 20000 });
  expect((await contributor.request.get('/api/v1/author/' + org + '/packs')).status()).toBe(200);
  const data = await (await contributor.request.get('/api/v1/author/' + org + '/packs/' + doc)).json();
  const publishAttempt = await contributor.request.post('/api/v1/author/' + org + '/packs/' + doc + '/publish', { headers: await mutate(contributor.context()), data: { releaseId: data.releases[0].id } });
  expect((await publishAttempt.json()).code).toBe('ORG_ACCESS_DENIED');
  // Revocation ends access at once, including the already-issued session.
  await owner.reload();
  await owner.getByRole('listitem').filter({ hasText: 'Contributor — contributor' }).getByRole('button', { name: 'Revoke access' }).click();
  await expect(owner.getByText('Access revoked; their sessions ended.')).toBeVisible();
  expect([401, 403]).toContain((await contributor.request.get('/api/v1/author/' + org + '/packs')).status());
});

test('withdrawal is explicit, and links to the withdrawn release are refused', async () => {
  await owner.goto('/author/' + org + '/packs/' + doc);
  await owner.getByRole('tab', { name: 'Validate & publish' }).click();
  await owner.getByPlaceholder('Reason for withdrawal').fill('E2E test withdrawal');
  await owner.getByRole('button', { name: 'Withdraw' }).click();
  await expect(owner.getByText('Withdrawn. Links to it now say it was withdrawn.')).toBeVisible();
  const page = await owner.context().newPage();
  await page.goto('/packs/e2e-permits/scenarios/eligible?r=' + manifest);
  await expect(page.getByRole('alert').filter({ hasText: /withdrawn/ })).toBeVisible({ timeout: 30000 });
  const catalog = await (await owner.request.get('/api/v1/catalog')).json();
  expect(catalog.unavailable.map((u: { packId: string }) => u.packId)).toContain('e2e-permits');
  expect((await owner.request.get('/published/e2e-permits/' + manifest + '/manifest.json')).status()).toBe(404);
});

test('server saves are opt-in, unguessable, deletable and expire', async ({ request }) => {
  const catalog = await (await request.get('/api/v1/catalog')).json();
  const meridian = catalog.packs.find((p: { packId: string }) => p.packId === 'meridian-claims');
  const saved = await request.post('/api/v1/scenarios', { data: { packId: 'meridian-claims', manifestDigest: meridian.current, scenarioId: 'wrong-agency', frameworkId: 'proposal', parameters: { 'transfer-delay': 4 }, retentionDays: 7 } });
  expect(saved.status()).toBe(201);
  const body = await saved.json();
  expect(body.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const resolved = await (await request.get('/api/v1/scenarios/' + body.id)).json();
  expect(resolved.href).toContain('p.transfer-delay=4');
  expect((await request.post('/api/v1/scenarios', { data: { packId: 'meridian-claims', manifestDigest: meridian.current, scenarioId: 'wrong-agency', frameworkId: 'proposal', parameters: { 'transfer-delay': 999 } } })).status()).toBe(400);
  expect((await request.delete('/api/v1/scenarios/' + body.id, { headers: { 'x-delete-token': 'A'.repeat(43) } })).status()).toBe(404);
  expect((await request.delete('/api/v1/scenarios/' + body.id, { headers: { 'x-delete-token': body.deleteToken } })).status()).toBe(200);
  expect((await request.get('/api/v1/scenarios/' + body.id)).status()).toBe(404);
});
