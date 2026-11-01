// Adapter: any tool that emits SARIF (semgrep, CodeQL, eslint with a SARIF formatter...).
// Config: { "type": "sarif", "command": "semgrep scan --sarif --baseline-commit {base} ...",
//           "output": null | "path/to/file.sarif", "prefix": "S" }
// {base} and {head} are replaced with the commit range. Without "output", SARIF is read from stdout.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fromSarif } from '../findings.mjs';

export function available({ conf, env = process.env }) {
  if (!conf.command) return { ok: false, reason: 'sarif reviewer needs a "command"' };
  for (const tool of [].concat(conf.requires || [])) {
    const found = spawnSync('sh', ['-c', `command -v ${JSON.stringify(tool)}`], { env, stdio: 'ignore' }).status === 0;
    if (!found) return { ok: false, reason: `${tool} is not installed` };
  }
  return { ok: true };
}

export async function run({ name, conf, cwd, base, head, env = process.env }) {
  const cmd = conf.command.replaceAll('{base}', base).replaceAll('{head}', head);
  const stdout = await new Promise((resolve, reject) => {
    const p = spawn(cmd, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    // Many scanners exit non-zero when they find something; only a missing output is fatal.
    p.on('close', (code) => (out || conf.output ? resolve(out) : reject(new Error(`"${cmd}" exited ${code}: ${err.slice(0, 300)}`))));
  });
  const raw = conf.output ? (existsSync(join(cwd, conf.output)) ? readFileSync(join(cwd, conf.output), 'utf8') : '') : stdout;
  if (!raw.trim()) throw new Error(`no SARIF produced by "${cmd}"`);
  const findings = fromSarif(JSON.parse(raw), { source: name, prefix: conf.prefix || 'S' });
  return { title: `🔎 ${name}`, findings };
}
