import express, { Request, Response } from 'express';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
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

type CdpTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

function getCdpBaseUrl(): string {
  return (process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222').replace(/\/$/, '');
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return await response.json() as T;
}

async function getCdpTargets(): Promise<CdpTarget[]> {
  return await fetchJson<CdpTarget[]>(`${getCdpBaseUrl()}/json/list`);
}

async function openMonarchTab(): Promise<CdpTarget> {
  const url = process.env.BROWSER_START_URL || 'https://app.monarchmoney.com/login';
  return await fetchJson<CdpTarget>(`${getCdpBaseUrl()}/json/new?${encodeURIComponent(url)}`);
}

function cdpCall(webSocketUrl: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP ${method} timed out`));
    }, 10000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });

    ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (message.error) {
        reject(new Error(message.error.message || 'CDP error'));
        return;
      }
      resolve(message.result);
    });

    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function cdpEvaluate(webSocketUrl: string, expression: string): Promise<unknown> {
  const result = await cdpCall(webSocketUrl, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result?.exceptionDetails) {
    throw new Error('CDP evaluation exception');
  }
  return result?.result?.value;
}

async function findMonarchPage(): Promise<CdpTarget | null> {
  const targets = await getCdpTargets();
  return targets.find((target) =>
    target.type === 'page' &&
    target.webSocketDebuggerUrl &&
    /monarch(money)?\.com/i.test(target.url)
  ) || null;
}

async function getBrowserTokenCandidates(): Promise<Array<{ source: string; key: string; length: number; value: string }>> {
  let page = await findMonarchPage();
  if (!page) {
    await openMonarchTab();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    page = await findMonarchPage();
  }
  if (!page?.webSocketDebuggerUrl) {
    throw new Error('No Monarch browser tab available via CDP');
  }

  const expression = `(() => {
    const out = [];
    const seen = new Set();
    const add = (source, key, value) => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (trimmed.length < 20) return;
      const id = source + ':' + key + ':' + trimmed.slice(0, 24);
      if (seen.has(id)) return;
      if (/token|jwt|auth|session|access/i.test(key) || /^eyJ/.test(trimmed) || trimmed.length > 80) {
        seen.add(id);
        out.push({ source, key, length: trimmed.length, value: trimmed });
      }
    };
    const walk = (source, key, value, depth = 0) => {
      if (depth > 5 || value == null) return;
      if (typeof value === 'string') {
        add(source, key, value);
        if ((value.startsWith('{') || value.startsWith('[')) && value.length < 200000) {
          try { walk(source, key + '.json', JSON.parse(value), depth + 1); } catch (_) {}
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, idx) => walk(source, key + '[' + idx + ']', item, depth + 1));
        return;
      }
      if (typeof value === 'object') {
        Object.entries(value).forEach(([k, v]) => walk(source, key + '.' + k, v, depth + 1));
      }
    };
    const collect = (source, store) => {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        walk(source, key, store.getItem(key) || '');
      }
    };
    collect('localStorage', window.localStorage);
    collect('sessionStorage', window.sessionStorage);
    return out;
  })()`;

  const result = await cdpEvaluate(page.webSocketDebuggerUrl, expression);
  const candidates = Array.isArray(result)
    ? result.filter((candidate: any) => typeof candidate?.value === 'string')
    : [];

  const cookiesResult = await cdpCall(page.webSocketDebuggerUrl, 'Network.getAllCookies');
  const cookies = Array.isArray(cookiesResult?.cookies) ? cookiesResult.cookies : [];
  for (const cookie of cookies) {
    if (!/monarch(money)?\.com$/i.test(String(cookie.domain || '').replace(/^\./, ''))) continue;
    const value = String(cookie.value || '').trim();
    if (value.length >= 20) {
      candidates.push({
        source: 'cookie',
        key: String(cookie.name || 'unknown'),
        length: value.length,
        value,
      });
    }
  }

  return candidates;
}

async function refreshTokenFromBrowser(): Promise<{ refreshed: boolean; candidates: number; saved_key?: string }> {
  const candidates = await getBrowserTokenCandidates();
  for (const candidate of candidates) {
    const token = candidate.value.trim();
    if (token.length < 40) continue;
    const client = createMonarchClient(token);
    if (await client.testConnection()) {
      saveMonarchToken(token);
      clearStatusCache();
      return {
        refreshed: true,
        candidates: candidates.length,
        saved_key: `${candidate.source}:${candidate.key}`,
      };
    }
  }
  return { refreshed: false, candidates: candidates.length };
}

async function probeBrowserGraphql(): Promise<{ ok: boolean; totalCount?: number; error?: string; status?: number; preview?: string }> {
  const page = await findMonarchPage();
  if (!page?.webSocketDebuggerUrl) {
    return { ok: false, error: 'No logged-in Monarch page found' };
  }

  const expression = `(() => {
    const cookie = document.cookie || '';
    const csrf = (cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || (cookie.match(/(?:^|; )csrf=([^;]+)/) || [])[1] || '';
    const findDeviceUuid = () => {
      const scan = (value, depth = 0) => {
        if (depth > 5 || value == null) return '';
        if (typeof value === 'string') {
          if (/^[0-9a-f-]{32,36}$/i.test(value)) return value;
          if ((value.startsWith('{') || value.startsWith('[')) && value.length < 200000) {
            try { return scan(JSON.parse(value), depth + 1); } catch (_) {}
          }
          return '';
        }
        if (Array.isArray(value)) {
          for (const item of value) { const found = scan(item, depth + 1); if (found) return found; }
          return '';
        }
        if (typeof value === 'object') {
          for (const [key, nested] of Object.entries(value)) {
            if (/device.*uuid|uuid/i.test(key) && typeof nested === 'string' && nested.length >= 16) return nested;
            const found = scan(nested, depth + 1); if (found) return found;
          }
        }
        return '';
      };
      for (const store of [window.localStorage, window.sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (/device.*uuid|uuid/i.test(key || '')) {
            const direct = store.getItem(key) || '';
            if (direct.length >= 16) return direct;
          }
          const found = scan(store.getItem(key) || '');
          if (found) return found;
        }
      }
      return '';
    };
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Client-Platform': 'web',
      'Monarch-Client': 'monarch-core-web-app-graphql',
      'Monarch-Client-Version': 'v1.0.1772'
    };
    if (csrf) headers['x-csrftoken'] = decodeURIComponent(csrf);
    const deviceUuid = findDeviceUuid();
    if (deviceUuid) headers['device-uuid'] = deviceUuid;
    return fetch('https://api.monarch.com/graphql', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        query: 'query BrowserProbe { allTransactions { totalCount __typename } }',
        variables: {}
      })
    }).then(async (r) => ({ status: r.status, text: await r.text(), sentHeaders: Object.keys(headers) }));
  })()`;

  try {
    const result: any = await cdpEvaluate(page.webSocketDebuggerUrl, expression);
    if (!result || result.status < 200 || result.status >= 300) {
      return { ok: false, status: result?.status, error: `HTTP ${result?.status || 'unknown'}`, preview: String(result?.text || '').slice(0, 180) };
    }
    const parsed = JSON.parse(String(result.text || '{}'));
    const totalCount = parsed?.data?.allTransactions?.totalCount;
    if (typeof totalCount === 'number') {
      return { ok: true, totalCount };
    }
    return { ok: false, error: parsed?.errors?.[0]?.message || 'No totalCount in response', preview: String(result.text || '').slice(0, 180) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function cdpCaptureGraphql(webSocketUrl: string): Promise<{ ok: boolean; url?: string; method?: string; header_names?: string[]; auth_header?: boolean; bearer_saved?: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketUrl);
    let settled = false;
    let nextId = 1;
    const send = (method: string, params: Record<string, unknown> = {}) => {
      ws.send(JSON.stringify({ id: nextId++, method, params }));
    };
    const finish = (value: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'Timed out waiting for Monarch GraphQL request' }), 30000);

    ws.on('open', () => {
      send('Network.enable');
      send('Page.enable');
      setTimeout(() => send('Page.reload', { ignoreCache: true }), 500);
    });

    ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.method !== 'Network.requestWillBeSent') return;
      const req = message.params?.request;
      const url = String(req?.url || '');
      if (!url.includes('api.monarch.com/graphql')) return;
      if (String(req?.method || '').toUpperCase() === 'OPTIONS') return;
      const headers = req?.headers || {};
      const headerNames = Object.keys(headers).sort();
      const authValue = String(headers.Authorization || headers.authorization || '');
      let bearerSaved = false;
      if (authValue.startsWith('Bearer ') && authValue.length > 40) {
        saveMonarchToken(authValue.slice('Bearer '.length));
        bearerSaved = true;
      }
      finish({
        ok: true,
        url,
        method: req?.method,
        header_names: headerNames,
        auth_header: Boolean(authValue),
        bearer_saved: bearerSaved,
      });
    });

    ws.on('error', (error) => {
      if (!settled) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

async function captureBrowserGraphql(): Promise<{ ok: boolean; url?: string; method?: string; header_names?: string[]; auth_header?: boolean; bearer_saved?: boolean; error?: string }> {
  const page = await findMonarchPage();
  if (!page?.webSocketDebuggerUrl) {
    return { ok: false, error: 'No logged-in Monarch page found' };
  }
  try {
    return await cdpCaptureGraphql(page.webSocketDebuggerUrl);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function renderBrowserPage(key: string, message = ''): string {
  const vncPassword = process.env.NOVNC_PASSWORD ? 'configured' : 'missing';
  const novncUrl = process.env.NOVNC_PUBLIC_URL || 'https://monarch-browser.etdofresh.com/vnc.html';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Monarch Browser Admin</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;margin:0}main{max-width:720px;margin:8vh auto;padding:28px;background:#111827;border:1px solid #334155;border-radius:18px}a,button{color:#082f49;background:#38bdf8;border:0;border-radius:10px;padding:10px 14px;font-weight:800;text-decoration:none;cursor:pointer}.row{display:flex;gap:12px;flex-wrap:wrap}.msg{margin:16px 0;padding:12px;border-radius:12px;background:#1e293b;white-space:pre-wrap}.hint{color:#94a3b8;line-height:1.45}code{background:#020617;padding:2px 5px;border-radius:6px}</style></head>
<body><main><h1>Monarch Browser Admin</h1>
<p class="hint">Use noVNC to log into Monarch in the persistent container browser. Then refresh the ingestor token from browser storage.</p>
${message ? `<div class="msg">${htmlEscape(message)}</div>` : ''}
<p>noVNC password: <code>${vncPassword}</code></p>
<div class="row">
  <a href="${htmlEscape(novncUrl)}" target="_blank">Open noVNC</a>
  <form method="post" action="/admin/browser/open"><input type="hidden" name="key" value="${htmlEscape(key)}" /><button type="submit">Open Monarch tab</button></form>
  <form method="post" action="/admin/browser/refresh-token"><input type="hidden" name="key" value="${htmlEscape(key)}" /><button type="submit">Refresh token from browser</button></form>
  <form method="post" action="/admin/browser/probe-graphql"><input type="hidden" name="key" value="${htmlEscape(key)}" /><button type="submit">Probe browser GraphQL</button></form>
  <form method="post" action="/admin/browser/capture-graphql"><input type="hidden" name="key" value="${htmlEscape(key)}" /><button type="submit">Capture real GraphQL request</button></form>
</div>
<p class="hint">CDP stays localhost-only; this page never prints cookies or tokens.</p>
</main></body></html>`;
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

  app.get('/admin/browser', (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    res.type('html').send(renderBrowserPage(String(req.query.key || '')));
  });

  app.get('/admin/browser/status', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const targets = await getCdpTargets();
      res.json({
        ok: true,
        cdp_reachable: true,
        pages: targets
          .filter((target) => target.type === 'page')
          .map((target) => ({ title: target.title, url: target.url })),
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        cdp_reachable: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/admin/browser/open', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const key = String(req.body?.key || req.query.key || '');
    try {
      await openMonarchTab();
      res.type('html').send(renderBrowserPage(key, 'Opened Monarch login tab in the container browser.'));
    } catch (error) {
      res.status(500).type('html').send(renderBrowserPage(key, `Failed to open Monarch tab: ${error instanceof Error ? error.message : String(error)}`));
    }
  });

  app.post('/admin/browser/refresh-token', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const key = String(req.body?.key || req.query.key || '');
    try {
      const result = await refreshTokenFromBrowser();
      if (!result.refreshed) {
        res.status(400).type('html').send(renderBrowserPage(key, `No usable Monarch API token found in browser storage. Candidates scanned: ${result.candidates}. Log into Monarch in noVNC, then retry.`));
        return;
      }

      const { runSync } = await import('./sync.js');
      runSync({ full: false }).catch((error) => {
        console.error('[admin-browser] Sync error after browser token refresh:', error);
      });
      res.type('html').send(renderBrowserPage(key, `Token refreshed from browser storage (${result.saved_key}). Incremental sync started.`));
    } catch (error) {
      res.status(500).type('html').send(renderBrowserPage(key, `Browser refresh failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  });

  app.post('/admin/browser/probe-graphql', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const key = String(req.body?.key || req.query.key || '');
    const result = await probeBrowserGraphql();
    const message = result.ok
      ? `Browser GraphQL works. Monarch reports ${result.totalCount} transactions.`
      : `Browser GraphQL probe failed: ${result.error}${result.preview ? `\nPreview: ${result.preview}` : ''}`;
    res.status(result.ok ? 200 : 400).type('html').send(renderBrowserPage(key, message));
  });

  app.post('/admin/browser/capture-graphql', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const key = String(req.body?.key || req.query.key || '');
    const result = await captureBrowserGraphql();
    if (result.bearer_saved) {
      const { runSync } = await import('./sync.js');
      runSync({ full: false }).catch((error) => {
        console.error('[admin-browser] Sync error after captured bearer refresh:', error);
      });
    }
    const message = result.ok
      ? `Captured Monarch GraphQL request.\nMethod: ${result.method}\nAuth header present: ${result.auth_header}\nBearer token saved: ${result.bearer_saved}\nHeaders: ${(result.header_names || []).join(', ')}`
      : `GraphQL capture failed: ${result.error}`;
    res.status(result.ok ? 200 : 400).type('html').send(renderBrowserPage(key, message));
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
