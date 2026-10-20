import { createApp } from './app.ts';
import { pool } from './db.ts';
import { startWorkers } from './outbox.ts';

const prod = process.env.NODE_ENV === 'production';
if (prod && process.env.DEV_AUTH === 'true') {
  console.error('Refusing to start: DEV_AUTH must never be enabled in production.');
  process.exit(1);
}
if (prod && !(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  console.error('Refusing to start: production needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (sign-in and private file storage).');
  process.exit(1);
}

const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3000); // API_PORT lets local dev keep the API off the web dev server's port
const server = createApp().listen(port, () => console.log(`Valor & Wellbeing Hub API on :${port}${process.env.DEV_AUTH === 'true' ? ' (DEV sign-in enabled — fictional accounts only)' : ''}`));

startWorkers();

const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
