import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * LM-041 static public distribution. Builds a copy of the web app without any
 * server-only surface (authoring, APIs, saved scenarios, startup jobs) as plain
 * files under dist/static. Host it on any static file host; it needs no
 * database, credentials, AI provider or Render service. Releases are verified
 * in the visitor's browser exactly as on the full deployment.
 */
const root = new URL('../', import.meta.url).pathname;
const work = join(root, 'apps', 'static-export');
const out = join(root, 'dist', 'static');
const run = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', DATABASE_URL: '', AUTH_DATABASE_URL: '' } }); if (r.status !== 0) process.exit(r.status ?? 1); };
rmSync(work, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
run(process.execPath, ['--import', 'tsx', 'scripts/packs.ts', 'public'], root);
cpSync(join(root, 'apps', 'web'), work, { recursive: true, verbatimSymlinks: true, filter: src => !/\/(\.next|test-results)(\/|$)/.test(src) });
for (const dir of ['app/api', 'app/author', 'app/published', 'app/s', 'app/components/author']) rmSync(join(work, dir), { recursive: true, force: true });
rmSync(join(work, 'instrumentation.ts'), { force: true });
// Static export renders every page at build time: no on-demand parameters or revalidation.
const walk = dir => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
for (const file of walk(join(work, 'app')).filter(f => f.endsWith('.tsx'))) {
  const text = readFileSync(file, 'utf8');
  const next = text.replace(/export const dynamicParams = true;/g, 'export const dynamicParams = false;').replace(/export const revalidate = 60;\n?/g, '');
  if (next !== text) writeFileSync(file, next);
}
writeFileSync(join(work, 'next.config.ts'), "import type { NextConfig } from 'next';\nconst config: NextConfig = { output: 'export', trailingSlash: true, images: { unoptimized: true }, poweredByHeader: false, reactStrictMode: true };\nexport default config;\n");
writeFileSync(join(work, 'package.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(work, 'package.json'), 'utf8')), name: '@law-machine/static-export' }, null, 2));
run(join(work, 'node_modules', '.bin', 'next'), ['build'], work);
cpSync(join(work, 'out'), out, { recursive: true });
rmSync(work, { recursive: true, force: true });
writeFileSync(join(out, 'STATIC-DISTRIBUTION.txt'), 'Law Machine static public build. Authoring, server verification and saved scenarios are not included. Serve these files over HTTPS from any static host.\n');
console.log('Static public build written to dist/static (' + walk(out).length + ' files).');
if (!existsSync(join(out, 'index.html'))) process.exit(1);
