import express, { Request, Response } from 'express';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { getStatus, clearStatusCache } from './sync.js';
import { createMonarchClient } from './monarch-client.js';

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getAdminToken(): string | undefined {
  return process.env.MONARCH_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
}

function isAuthorized(req: Request): boolean {
  const token = getAdminToken();
  if (!token) return false;

  const bearer = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const submitted = bearer || String(req.query.key || req.body?.key || '');
  return submitted === token;
}

function requireAdmin(req: Request, res: Response): boolean {
  if (isAuthorized(req)) return true;
  res.status(404).send('Not found');
  return false;
}

function saveMonarchToken(token: string): void {
  const envPath = path.resolve(process.cwd(), '.env');
  let envContent = '';

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8');
  }

  const lines = envContent
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('MONARCH_TOKEN='));
  lines.push(`MONARCH_TOKEN=${token}`);
  fs.writeFileSync(envPath, `${lines.join('\n')}\n`);
  process.env.MONARCH_TOKEN = token;
}

function renderMfaPage(key: string, message = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Monarch MFA Refresh</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; }
    main { max-width: 520px; margin: 10vh auto; padding: 28px; background: #111827; border: 1px solid #334155; border-radius: 18px; }
    h1 { margin-top: 0; font-size: 1.5rem; }
    label { display: block; margin: 18px 0 8px; color: #cbd5e1; }
    input { width: 100%; box-sizing: border-box; font-size: 2rem; letter-spacing: .35em; padding: 12px; border-radius: 12px; border: 1px solid #475569; background: #020617; color: #f8fafc; text-align: center; }
    button { margin-top: 18px; width: 100%; padding: 14px 18px; border: 0; border-radius: 12px; background: #38bdf8; color: #082f49; font-weight: 800; font-size: 1rem; cursor: pointer; }
    .msg { margin: 16px 0; padding: 12px; border-radius: 12px; background: #1e293b; white-space: pre-wrap; }
    .hint { color: #94a3b8; font-size: .95rem; line-height: 1.4; }
  </style>
</head>
<body>
  <main>
    <h1>Monarch MFA Refresh</h1>
    <p class="hint">Enter the current 6-digit Monarch authenticator code. This refreshes the ingestor token and starts a sync.</p>
    ${message ? `<div class="msg">${htmlEscape(message)}</div>` : ''}
    <form method="post" action="/admin/mfa">
      <input type="hidden" name="key" value="${htmlEscape(key)}" />
      <label for="mfaCode">MFA code</label>
      <input id="mfaCode" name="mfaCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus />
      <button type="submit">Refresh token + sync</button>
    </form>
  </main>
</body>
</html>`;
}

export function createServer(): express.Application {
  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy' });
  });

  // Status endpoint
  app.get('/api/status', async (req: Request, res: Response) => {
    try {
      const refresh = req.query.refresh === 'true';
      const status = await getStatus(!refresh);
      res.json(status);
    } catch (error) {
      console.error('Error getting status:', error);
      res.status(500).json({
        service: 'monarch-money',
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        cached_at: new Date().toISOString(),
      });
    }
  });

  // Force refresh
  app.post('/api/status/refresh', async (_req: Request, res: Response) => {
    try {
      clearStatusCache();
      const status = await getStatus(false);
      res.json(status);
    } catch (error) {
      console.error('Error refreshing status:', error);
      res.status(500).json({
        service: 'monarch-money',
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        cached_at: new Date().toISOString(),
      });
    }
  });

  // Trigger sync
  app.post('/api/sync', async (req: Request, res: Response) => {
    try {
      // Import sync function
      const { runSync } = await import('./sync.js');
      const full = req.query.full === 'true';

      // Run sync in background and return immediately
      res.json({
        status: 'syncing',
        message: `Starting ${full ? 'full' : 'incremental'} sync`,
        sync_type: full ? 'full' : 'incremental',
      });

      // Run sync (don't await - run in background)
      runSync({ full }).catch((error) => {
        console.error('Sync error:', error);
      });
    } catch (error) {
      console.error('Error starting sync:', error);
      res.status(500).json({
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Protected admin page for one-time Monarch MFA refresh.
  app.get('/admin/mfa', (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    res.type('html').send(renderMfaPage(String(req.query.key || '')));
  });

  app.post('/admin/mfa', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const key = String(req.body?.key || req.query.key || '');
    const mfaCode = String(req.body?.mfaCode || '').trim();
    if (!/^\d{6}$/.test(mfaCode)) {
      res.status(400).type('html').send(renderMfaPage(key, 'Enter a fresh 6-digit MFA code.'));
      return;
    }

    const email = process.env.MONARCH_EMAIL;
    const password = process.env.MONARCH_PASSWORD;
    if (!email || !password) {
      res.status(500).type('html').send(renderMfaPage(key, 'MONARCH_EMAIL and MONARCH_PASSWORD are not configured.'));
      return;
    }

    try {
      const client = createMonarchClient();
      const { token } = await client.login(email, password, mfaCode);
      saveMonarchToken(token);
      clearStatusCache();

      const { runSync } = await import('./sync.js');
      runSync({ full: false }).catch((error) => {
        console.error('[admin-mfa] Sync error after MFA refresh:', error);
      });

      res.type('html').send(renderMfaPage(key, 'Token refreshed successfully. Incremental sync started. Check /api/status in a minute.'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const safeMessage = message === 'MFA_REQUIRED'
        ? 'Monarch rejected that code or it expired. Wait for a fresh code and retry.'
        : `Refresh failed: ${message}`;
      res.status(400).type('html').send(renderMfaPage(key, safeMessage));
    }
  });

  return app;
}

export function startServer(port: number = 3001): void {
  const app = createServer();

  app.listen(port, () => {
    console.log(`Monarch Money Ingestor server running on port ${port}`);
    console.log(`  Status:  http://localhost:${port}/api/status`);
    console.log(`  Health:  http://localhost:${port}/health`);

    // Auto-sync setup
    const syncIntervalMs = parseInt(process.env.SYNC_INTERVAL_MS || '14400000', 10);

    if (syncIntervalMs > 0) {
      console.log(`  Auto-sync: every ${syncIntervalMs / 1000}s (${(syncIntervalMs / 3600000).toFixed(1)}h)`);

      // Initial sync after 30s delay
      setTimeout(async () => {
        console.log('[auto-sync] Running startup sync...');
        try {
          const { runSync } = await import('./sync.js');
          await runSync({ full: false });
          console.log('[auto-sync] Startup sync complete.');
        } catch (error) {
          console.error('[auto-sync] Startup sync failed:', error);
        }
      }, 30000);

      // Recurring sync
      setInterval(async () => {
        console.log('[auto-sync] Running scheduled sync...');
        try {
          const { runSync } = await import('./sync.js');
          await runSync({ full: false });
          console.log('[auto-sync] Scheduled sync complete.');
        } catch (error) {
          console.error('[auto-sync] Scheduled sync failed:', error);
        }
      }, syncIntervalMs);
    } else {
      console.log('  Auto-sync: disabled (SYNC_INTERVAL_MS=0)');
    }

    // Nightly full sync cron
    const nightlySyncEnabled = (process.env.NIGHTLY_SYNC_ENABLED || 'true').toLowerCase() === 'true';
    const nightlySyncCron = process.env.NIGHTLY_SYNC_CRON || '0 9 * * *';

    if (nightlySyncEnabled) {
      if (!cron.validate(nightlySyncCron)) {
        console.error(`[nightly-sync] Invalid cron expression: ${nightlySyncCron}`);
      } else {
        cron.schedule(nightlySyncCron, async () => {
          console.log('[nightly-sync] Starting nightly full sync...');
          const start = Date.now();
          try {
            const { runSync } = await import('./sync.js');
            await runSync({ full: true });
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.log(`[nightly-sync] Nightly full sync complete in ${elapsed}s.`);
          } catch (error) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.error(`[nightly-sync] Nightly full sync failed after ${elapsed}s:`, error);
          }
        }, { timezone: 'UTC' });
        console.log(`  Nightly sync: ${nightlySyncCron} (UTC)`);
      }
    } else {
      console.log('  Nightly sync: disabled (NIGHTLY_SYNC_ENABLED=false)');
    }
  });
}
