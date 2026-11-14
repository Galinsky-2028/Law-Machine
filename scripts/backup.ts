import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createBackup, restoreBackup, verifyRestored } from '../apps/web/app/lib/server/backup.ts';

/**
 * LM-053 operator commands (owner connection strings only; never the app roles):
 *   backup  <dir>             BACKUP_DATABASE_URL -> encrypted archive + summary
 *   restore <archive>         RESTORE_DATABASE_URL (empty, isolated) -> restore, verify, report RPO/RTO
 *   verify                    RESTORE_DATABASE_URL -> integrity and replay check only
 */
const [command, arg] = process.argv.slice(2);
if (command === 'backup') {
  const url = process.env.BACKUP_DATABASE_URL;
  if (!url || !arg) throw Error('Usage: BACKUP_DATABASE_URL=... LM_BACKUP_KEY=... backup <dir>');
  const b = await createBackup(url);
  mkdirSync(arg, { recursive: true });
  const name = 'law-machine-' + b.createdAt.replace(/[:.]/g, '-') + '.lmb';
  writeFileSync(arg + '/' + name, b.archive, { mode: 0o600 });
  writeFileSync(arg + '/' + name + '.json', JSON.stringify({ createdAt: b.createdAt, sha256: b.digest, rows: b.summary }, null, 1));
  console.log('backup ' + name + ' (' + b.archive.length + ' bytes, encrypted) rows ' + JSON.stringify(b.summary));
} else if (command === 'restore') {
  const url = process.env.RESTORE_DATABASE_URL;
  if (!url || !arg) throw Error('Usage: RESTORE_DATABASE_URL=... LM_BACKUP_KEY=... restore <archive>');
  const r = await restoreBackup(readFileSync(arg), url);
  console.log(JSON.stringify({ restored: r.restored, recoveryTimeSeconds: Math.round(r.durationMs / 100) / 10, recoveryPointAgeSeconds: r.recoveryPointAgeSeconds, verification: r.verification }, null, 1));
  if (!r.verification.ok) process.exit(1);
} else if (command === 'verify') {
  const v = await verifyRestored(process.env.RESTORE_DATABASE_URL!);
  console.log(JSON.stringify(v, null, 1));
  if (!v.ok) process.exit(1);
} else throw Error('Unknown command');
