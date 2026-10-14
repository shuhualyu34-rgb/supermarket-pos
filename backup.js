import { chmodSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createDailyBackup(db) {
  const databaseFile = db.prepare('PRAGMA database_list').all().find((entry) => entry.name === 'main')?.file;
  if (!databaseFile) return null;
  const backupDir = join(dirname(databaseFile), 'backups');
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const day = new Date().toISOString().slice(0, 10);
  const backupFile = join(backupDir, `pos-${day}.sqlite`);
  const tempFile = join(backupDir, `.pos-${randomUUID()}.sqlite`);
  db.exec(`VACUUM INTO '${tempFile.replaceAll("'", "''")}'`);
  chmodSync(tempFile, 0o600);
  renameSync(tempFile, backupFile);
  return backupFile;
}
