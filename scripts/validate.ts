/**
 * automation-hub — workflow validator (also the lib -> workflow sync tool)
 * =====================================================================
 * Used by CI (`.github/workflows/validate.yml`) and locally:
 *   npm run validate        # check only (fails on any problem or drift)
 *   npm run sync            # = validate --fix: re-inject lib into workflow.json
 *
 * Checks performed per workflows/<name>/workflow.json:
 *   1. Valid JSON.
 *   2. Required shape: name, nodes[], connections{}, at least one trigger.
 *   3. Each node has id/name/type/typeVersion/position/parameters.
 *   4. Every connection references an existing node.
 *   5. Every credential-bearing node references a credential.
 *   6. The Code node's LIB region matches lib/calendar-upsert.js (no drift).
 *   7. The Code node body is syntactically valid JavaScript.
 *
 * NO deploy, NO secrets, NO network — safe to run anywhere.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS_DIR = join(ROOT, 'workflows');
const LIB_FILE = join(ROOT, 'lib', 'calendar-upsert.js');

const FIX = process.argv.includes('--fix');

const problems: string[] = [];
let fixedCount = 0;

/** Extract the dependency-free region from lib/calendar-upsert.js. */
function extractLibRegion(source: string): string {
  const m = source.match(/====\s*INLINE:START[^\n]*\n([\s\S]*?)\n[^\n]*====\s*INLINE:END/);
  if (!m) throw new Error('Could not find INLINE:START/INLINE:END markers in lib/calendar-upsert.js');
  return m[1].trim();
}

/** Extract the region between the exact `// LIB:START` / `// LIB:END` lines. */
function findCodeLibRegion(jsCode: string): { start: number; end: number; region: string } | null {
  const lines = jsCode.split('\n');
  const start = lines.findIndex((l) => l.trim() === '// LIB:START');
  const end = lines.findIndex((l) => l.trim() === '// LIB:END');
  if (start === -1 || end === -1 || end <= start) return null;
  return { start, end, region: lines.slice(start + 1, end).join('\n').trim() };
}

function injectLibRegion(jsCode: string, libRegion: string): string {
  const lines = jsCode.split('\n');
  const start = lines.findIndex((l) => l.trim() === '// LIB:START');
  const end = lines.findIndex((l) => l.trim() === '// LIB:END');
  return [...lines.slice(0, start + 1), ...libRegion.split('\n'), ...lines.slice(end)].join('\n');
}

function isNumberPair(v: unknown): boolean {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number');
}

function validateWorkflow(dir: string, libRegion: string): void {
  const file = join(WORKFLOWS_DIR, dir, 'workflow.json');
  const label = `workflows/${dir}/workflow.json`;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    problems.push(`${label}: file not found`);
    return;
  }

  let wf: any;
  try {
    wf = JSON.parse(raw);
  } catch (e) {
    problems.push(`${label}: invalid JSON — ${(e as Error).message}`);
    return;
  }

  // --- top-level shape ---
  if (typeof wf.name !== 'string' || !wf.name.trim()) problems.push(`${label}: missing "name"`);
  if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) {
    problems.push(`${label}: "nodes" must be a non-empty array`);
    return;
  }
  if (typeof wf.connections !== 'object' || wf.connections === null) {
    problems.push(`${label}: missing "connections" object`);
  }

  const nodeNames = new Set<string>();
  let triggerCount = 0;
  for (const [i, node] of wf.nodes.entries()) {
    const at = `${label}: node[${i}] (${node?.name ?? '?'})`;
    if (typeof node.id !== 'string') problems.push(`${at}: missing "id"`);
    if (typeof node.name !== 'string') problems.push(`${at}: missing "name"`);
    else {
      if (nodeNames.has(node.name)) problems.push(`${at}: duplicate node name`);
      nodeNames.add(node.name);
    }
    if (typeof node.type !== 'string' || !node.type.includes('.')) problems.push(`${at}: invalid "type"`);
    if (typeof node.typeVersion !== 'number') problems.push(`${at}: missing numeric "typeVersion"`);
    if (!isNumberPair(node.position)) problems.push(`${at}: "position" must be [x, y]`);
    if (typeof node.parameters !== 'object' || node.parameters === null) problems.push(`${at}: missing "parameters"`);
    if (typeof node.type === 'string' && (node.type.toLowerCase().includes('trigger') || node.type.endsWith('.webhook'))) {
      triggerCount++;
    }
    // credential-bearing HTTP nodes must reference a credential
    if (node.type === 'n8n-nodes-base.httpRequest' && node.parameters?.authentication && node.parameters.authentication !== 'none') {
      if (!node.credentials || Object.keys(node.credentials).length === 0) {
        problems.push(`${at}: uses authentication but has no "credentials" reference`);
      }
    }
  }
  if (triggerCount === 0) problems.push(`${label}: workflow has no trigger node`);

  // --- connections reference existing nodes ---
  for (const [source, conn] of Object.entries<any>(wf.connections ?? {})) {
    if (!nodeNames.has(source)) problems.push(`${label}: connection from unknown node "${source}"`);
    for (const outputs of Object.values<any>(conn)) {
      for (const group of outputs ?? []) {
        for (const link of group ?? []) {
          if (!nodeNames.has(link.node)) problems.push(`${label}: connection targets unknown node "${link.node}"`);
        }
      }
    }
  }

  // --- Code node: drift check + JS syntax ---
  let mutated = false;
  for (const node of wf.nodes) {
    if (node.type !== 'n8n-nodes-base.code') continue;
    const jsCode: string = node.parameters?.jsCode ?? '';
    const found = findCodeLibRegion(jsCode);
    if (!found) {
      problems.push(`${label}: Code node "${node.name}" has no // LIB:START / // LIB:END markers`);
      continue;
    }
    if (found.region !== libRegion) {
      if (FIX) {
        node.parameters.jsCode = injectLibRegion(jsCode, libRegion);
        mutated = true;
        fixedCount++;
      } else {
        problems.push(
          `${label}: Code node "${node.name}" is out of sync with lib/calendar-upsert.js — run \`npm run sync\``
        );
      }
    }
    // Syntax check: compile with the n8n globals bound as parameters (never executed).
    const codeToCheck = FIX ? node.parameters.jsCode : jsCode;
    try {
      // eslint-disable-next-line no-new-func
      new Function('$env', '$input', '$', '$json', 'items', codeToCheck);
    } catch (e) {
      problems.push(`${label}: Code node "${node.name}" has a JS syntax error — ${(e as Error).message}`);
    }
  }

  if (FIX && mutated) {
    writeFileSync(file, JSON.stringify(wf, null, 2) + '\n', 'utf8');
    console.log(`  fixed: ${label}`);
  }
}

// --------------------------------------------------------------------------

function main(): void {
  if (!existsSync(WORKFLOWS_DIR)) {
    console.error('No workflows/ directory found.');
    process.exit(1);
  }
  const libRegion = extractLibRegion(readFileSync(LIB_FILE, 'utf8'));

  const dirs = readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(WORKFLOWS_DIR, name, 'workflow.json')));

  if (dirs.length === 0) {
    console.error('No workflows/<name>/workflow.json files found.');
    process.exit(1);
  }

  console.log(`Validating ${dirs.length} workflow(s)${FIX ? ' (--fix)' : ''}:`);
  for (const dir of dirs) {
    console.log(`- ${dir}`);
    validateWorkflow(dir, libRegion);
  }

  if (problems.length > 0) {
    console.error(`\n✗ ${problems.length} problem(s) found:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(`\n✓ All workflows valid${FIX ? ` (${fixedCount} synced)` : ''}.`);
}

main();
