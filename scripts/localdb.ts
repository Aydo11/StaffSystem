// Development only: runs a real local Postgres (no system install) on :5432 with user/password hub/hub.
// Creates databases `hub` (dev) and `hub_test` (tests) on first run. Ctrl+C to stop.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../.pgdata', import.meta.url));
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'hub', password: 'hub', port: 5432, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
const fresh = !existsSync(dir);
if (fresh) await pg.initialise();
await pg.start();
if (fresh) {
  await pg.createDatabase('hub');
  await pg.createDatabase('hub_test');
}
console.log('Local Postgres ready: postgres://hub:hub@localhost:5432/hub (and hub_test)');
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
