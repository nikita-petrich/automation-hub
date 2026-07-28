/**
 * automation-hub — export the LIVE n8n workflows to a local backup folder.
 * =====================================================================
 *   npm run backup
 *
 * This is a SAFETY NET for disaster recovery, NOT part of the deployment
 * flow. The repository stays the single source of truth; deployment is
 * one-way (repo -> n8n). Backups are written to backups/<timestamp>/ which
 * is gitignored, so a live export can never silently overwrite the canonical
 * workflows/ definitions.
 *
 * Credentials are intentionally NOT exported (they contain secrets and live
 * only inside the encrypted n8n volume).
 *
 * Requires (from .env): N8N_API_URL, N8N_API_KEY.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(): void {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function fetchAll(base: string, key: string): Promise<any[]> {
  const clean = base.replace(/\/+$/, '');
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await fetch(`${clean}/api/v1/workflows?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
      headers: { 'X-N8N-API-KEY': key, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`GET /workflows -> ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
    const page = (await res.json()) as any;
    out.push(...(page.data ?? []));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

function timestamp(): string {
  // 2026-07-20T06-30-00Z -> filesystem-safe
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

async function main(): Promise<void> {
  loadEnv();
  const apiUrl = process.env.N8N_API_URL;
  const apiKey = process.env.N8N_API_KEY;
  if (!apiUrl || !apiKey) {
    console.error('Missing N8N_API_URL and/or N8N_API_KEY. Fill them in .env (see .env.example).');
    process.exit(1);
  }

  const workflows = await fetchAll(apiUrl, apiKey);
  const dir = join(ROOT, 'backups', timestamp());
  mkdirSync(dir, { recursive: true });

  for (const wf of workflows) {
    const safe = String(wf.name || wf.id).replace(/[^a-zA-Z0-9_-]+/g, '_');
    writeFileSync(join(dir, `${safe}.json`), JSON.stringify(wf, null, 2) + '\n', 'utf8');
  }
  writeFileSync(join(dir, '_index.json'), JSON.stringify(workflows.map((w) => ({ id: w.id, name: w.name, active: w.active })), null, 2) + '\n', 'utf8');

  console.log(`Backed up ${workflows.length} workflow(s) to ${dir}`);
}

main().catch((e) => {
  console.error('Backup failed:', e.message);
  process.exit(1);
});
