/**
 * automation-hub — deploy ALL workflows into the running n8n instance.
 * =====================================================================
 * This is the ONE-WAY door: repository -> n8n. It never reads state back.
 *
 *   npm run deploy
 *
 * What it does for every workflows/<name>/workflow.json:
 *   1. Re-injects lib/calendar-upsert.js into the Code node (single source).
 *   2. Injects BIRTHDAY_SYNC_SCHEDULE into the Schedule Trigger.
 *   3. Wires GOOGLE_OAUTH_CRED_ID into every HTTP Request node (if provided).
 *   4. UPSERTS by stable workflow NAME via the n8n Public REST API
 *      (create if absent, replace if present) — so repeated runs never
 *      create duplicates.
 *   5. Activates/deactivates according to the workflow's `active` flag.
 *
 * If the Public API is unreachable it falls back to `n8n import:workflow`
 * executed inside the container via `docker compose exec`.
 *
 * Requires (from .env): N8N_API_URL, N8N_API_KEY.
 * Optional (from .env): BIRTHDAY_SYNC_SCHEDULE, GOOGLE_OAUTH_CRED_ID.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS_DIR = join(ROOT, 'workflows');
const LIB_FILE = join(ROOT, 'lib', 'calendar-upsert.js');
const CRED_PLACEHOLDER = 'REPLACE_WITH_CRED_ID';

// ---------------------------------------------------------------------------
// .env loading (no dependency): KEY=VALUE, value = rest of line, quotes stripped.
// Existing process.env wins so you can override per-invocation.
// ---------------------------------------------------------------------------
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

function extractLibRegion(source: string): string {
  const m = source.match(/====\s*INLINE:START[^\n]*\n([\s\S]*?)\n[^\n]*====\s*INLINE:END/);
  if (!m) throw new Error('Could not find INLINE markers in lib/calendar-upsert.js');
  return m[1].trim();
}

function injectLibRegion(jsCode: string, libRegion: string): string {
  const lines = jsCode.split('\n');
  const start = lines.findIndex((l) => l.trim() === '// LIB:START');
  const end = lines.findIndex((l) => l.trim() === '// LIB:END');
  if (start === -1 || end === -1) return jsCode; // no markers -> leave as-is
  return [...lines.slice(0, start + 1), ...libRegion.split('\n'), ...lines.slice(end)].join('\n');
}

interface Built {
  name: string;
  active: boolean;
  payload: { name: string; nodes: any[]; connections: Record<string, unknown>; settings: Record<string, unknown> };
  credentialsWired: boolean;
}

/** Read a workflow.json and apply all deploy-time injections. */
function buildWorkflow(dir: string, libRegion: string, schedule: string | undefined, credId: string | undefined): Built {
  const wf = JSON.parse(readFileSync(join(WORKFLOWS_DIR, dir, 'workflow.json'), 'utf8'));
  let credentialsWired = true;

  for (const node of wf.nodes as any[]) {
    // 1. lib injection
    if (node.type === 'n8n-nodes-base.code' && typeof node.parameters?.jsCode === 'string') {
      node.parameters.jsCode = injectLibRegion(node.parameters.jsCode, libRegion);
    }
    // 2. schedule injection
    if (node.type === 'n8n-nodes-base.scheduleTrigger' && schedule) {
      node.parameters = node.parameters ?? {};
      node.parameters.rule = { interval: [{ field: 'cronExpression', expression: schedule }] };
    }
    // 3. credential wiring
    if (node.type === 'n8n-nodes-base.httpRequest' && node.credentials?.oAuth2Api) {
      if (credId) node.credentials.oAuth2Api.id = credId;
      if (!node.credentials.oAuth2Api.id || node.credentials.oAuth2Api.id === CRED_PLACEHOLDER) {
        credentialsWired = false;
      }
    }
  }

  return {
    name: wf.name,
    active: wf.active === true,
    payload: { name: wf.name, nodes: wf.nodes, connections: wf.connections ?? {}, settings: wf.settings ?? {} },
    credentialsWired,
  };
}

// ---------------------------------------------------------------------------
// n8n Public REST API client
// ---------------------------------------------------------------------------
class N8nApi {
  constructor(private base: string, private key: string) {
    this.base = base.replace(/\/+$/, '');
  }
  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.base}/api/v1${path}`, {
      method,
      headers: { 'X-N8N-API-KEY': this.key, 'Content-Type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  async ping(): Promise<boolean> {
    try {
      await this.req('GET', '/workflows?limit=1');
      return true;
    } catch {
      return false;
    }
  }
  async findByName(name: string): Promise<any | null> {
    let cursor: string | undefined;
    do {
      const page = await this.req('GET', `/workflows?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const match = (page.data ?? []).find((w: any) => w.name === name);
      if (match) return match;
      cursor = page.nextCursor;
    } while (cursor);
    return null;
  }
  create(payload: unknown) {
    return this.req('POST', '/workflows', payload);
  }
  update(id: string, payload: unknown) {
    return this.req('PUT', `/workflows/${id}`, payload);
  }
  activate(id: string) {
    return this.req('POST', `/workflows/${id}/activate`);
  }
  deactivate(id: string) {
    return this.req('POST', `/workflows/${id}/deactivate`);
  }
}

async function deployViaApi(api: N8nApi, built: Built[]): Promise<void> {
  for (const wf of built) {
    const existing = await api.findByName(wf.name);
    let id: string;
    if (existing) {
      await api.update(existing.id, wf.payload);
      id = existing.id;
      console.log(`  updated  "${wf.name}"  (id ${id})`);
    } else {
      const created = await api.create(wf.payload);
      id = created.id;
      console.log(`  created  "${wf.name}"  (id ${id})`);
    }

    if (wf.active && !wf.credentialsWired) {
      console.log(`  ! left INACTIVE: no Google credential wired yet. Set GOOGLE_OAUTH_CRED_ID in .env and re-run, or activate in the UI after attaching the credential.`);
      continue;
    }
    try {
      if (wf.active) {
        await api.activate(id);
        console.log(`  activated "${wf.name}"`);
      } else {
        await api.deactivate(id);
        console.log(`  deactivated "${wf.name}"`);
      }
    } catch (e) {
      console.log(`  ! could not change active state: ${(e as Error).message}`);
    }
  }
}

/** Fallback: write built workflows to dist/ and import them via the container CLI. */
function deployViaCli(built: Built[]): void {
  const outDir = join(ROOT, 'dist', 'deploy');
  mkdirSync(outDir, { recursive: true });
  console.log('Public API unreachable — falling back to `n8n import:workflow` via docker compose.\n');

  for (const wf of built) {
    const safe = wf.name.replace(/[^a-zA-Z0-9_-]+/g, '_');
    const localFile = join(outDir, `${safe}.json`);
    // import:workflow needs the id/active fields to upsert in place, so keep them.
    const full = { ...wf.payload, active: wf.active };
    writeFileSync(localFile, JSON.stringify(full, null, 2) + '\n', 'utf8');
    const containerFile = `/tmp/${safe}.json`;
    try {
      execFileSync('docker', ['compose', 'cp', localFile, `n8n:${containerFile}`], { cwd: ROOT, stdio: 'inherit' });
      execFileSync('docker', ['compose', 'exec', '-T', 'n8n', 'n8n', 'import:workflow', `--input=${containerFile}`], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      console.log(`  imported "${wf.name}" via CLI`);
    } catch (e) {
      console.error(`  ! CLI import failed for "${wf.name}": ${(e as Error).message}`);
      console.error(`    The built file is at ${localFile} — import it manually with:`);
      console.error(`      docker compose cp ${localFile} n8n:${containerFile}`);
      console.error(`      docker compose exec n8n n8n import:workflow --input=${containerFile}`);
    }
  }
  console.log('\nNote: the CLI import does not toggle active state — activate the workflow in the UI if needed.');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();
  const apiUrl = process.env.N8N_API_URL;
  const apiKey = process.env.N8N_API_KEY;
  const schedule = process.env.BIRTHDAY_SYNC_SCHEDULE?.trim();
  const credId = process.env.GOOGLE_OAUTH_CRED_ID?.trim() || undefined;

  if (!apiUrl || !apiKey) {
    console.error('Missing N8N_API_URL and/or N8N_API_KEY. Fill them in .env (see .env.example).');
    process.exit(1);
  }

  const libRegion = extractLibRegion(readFileSync(LIB_FILE, 'utf8'));
  const dirs = readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(WORKFLOWS_DIR, d.name, 'workflow.json')))
    .map((d) => d.name);

  if (dirs.length === 0) {
    console.error('No workflows to deploy.');
    process.exit(1);
  }

  const built = dirs.map((d) => buildWorkflow(d, libRegion, schedule, credId));
  console.log(`Deploying ${built.length} workflow(s) to ${apiUrl}`);
  if (!credId) console.log('(GOOGLE_OAUTH_CRED_ID not set — HTTP nodes will need their credential selected in the UI.)\n');

  const api = new N8nApi(apiUrl, apiKey);
  if (await api.ping()) {
    await deployViaApi(api, built);
  } else {
    deployViaCli(built);
  }
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('\nDeploy failed:', e.message);
  process.exit(1);
});
