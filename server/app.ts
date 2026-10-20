import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authenticate } from './auth.ts';
import { pool } from './db.ts';
import { errorHandler, HttpError } from './http.ts';
import { admin } from './routes/admin.ts';
import { core } from './routes/core.ts';
import { development } from './routes/development.ts';
import { leave } from './routes/leave.ts';
import { account, authPublic } from './routes/account.ts';
import { inbox } from './routes/inbox.ts';
import { people } from './routes/people.ts';
import { performance } from './routes/performance.ts';
import { cases } from './routes/cases.ts';
import { estates } from './routes/estates.ts';
import { finance } from './routes/finance.ts';
import { governance } from './routes/governance.ts';
import { messaging } from './routes/messaging.ts';
import { ai } from './routes/ai.ts';
import { dataops } from './routes/dataops.ts';
import { policies } from './routes/policies.ts';
import { training } from './routes/training.ts';
import { properties } from './routes/properties.ts';
import { tasks } from './routes/tasks.ts';
import { visits } from './routes/visits.ts';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render terminates TLS in front of the app
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('select 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'unreachable' });
    }
  });

  const api = express.Router();
  api.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MIN ?? 600), standardHeaders: 'draft-8', legacyHeaders: false }));
  api.use(express.json({ limit: '200kb' }));
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }); // never cache personal data
  api.use(authPublic);
  api.use(authenticate);
  api.use(account, core, inbox, people, properties, visits, tasks, performance, training, policies, governance, cases, estates, finance, messaging, ai, dataops, leave, development, admin);
  api.use(() => { throw new HttpError(404, 'not_found', 'No such API endpoint.'); });
  app.use('/api', api);

  // Production: serve the built web app (single origin, so no CORS is needed).
  const web = fileURLToPath(new URL('../web/', import.meta.url));
  if (import.meta.url.endsWith('.js') && existsSync(`${web}index.html`)) { // compiled build only; in dev Vite serves the web app
    app.use(express.static(web, { index: false, maxAge: '1h', setHeaders: (res, path) => { if (path.endsWith('sw.js')) res.set('Cache-Control', 'no-cache'); } }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(`${web}index.html`, { headers: { 'Cache-Control': 'no-cache' } }));
  }

  app.use(errorHandler);
  return app;
}
