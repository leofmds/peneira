import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFinding } from '../findings.mjs';

export const REPO_SKILL = '.agents/skills/ponytail-review/SKILL.md';
const LEGACY_SKILL = '.claude/skills/ponytail-review/SKILL.md';

export const RUNNERS = {
  claude: { bin: 'claude', binEnv: 'CLAUDE_BIN', secret: 'ANTHROPIC_API_KEY', label: 'Claude Code' },
  cursor: { bin: 'agent', binEnv: 'CURSOR_AGENT_BIN', secret: 'CURSOR_API_KEY', label: 'Cursor agent' },
  codex: { bin: 'codex', binEnv: 'CODEX_BIN', secret: 'CODEX_API_KEY', label: 'Codex' },
};

// User settings can carry hooks that approve any Bash command (and subagents inherit them), which
// would make the review able to write. Load only project settings and never skip permission prompts.
export const READ_ONLY = ['--setting-sources', 'project', '--permission-mode', 'default'];

const SCHEMA = `{
  "what_this_change_does": string,
  "verdict": string,
  "lean": string | null,
  "not_checked": string | null,
  "findings": [ { "number": number, "group": "must" | "should" | "nice", "title": string,
    "file": string | null, "line_start": number | null, "line_end": number | null,
    "problem": string, "fix": string } ]
}
title: 8 words or fewer, names what to cut. problem: one sentence, what is unnecessary and why.
fix: one sentence, what replaces it.`;

function skillSource(cwd) {
  if (existsSync(join(cwd, REPO_SKILL))) return { kind: 'repo', path: REPO_SKILL };
  if (existsSync(join(cwd, LEGACY_SKILL))) return { kind: 'repo', path: LEGACY_SKILL };
  const user = join(homedir(), '.claude/skills/ponytail-review/SKILL.md');
  if (existsSync(user)) return { kind: 'user', path: user };
  const plugin = pluginSkill();
  return plugin ? { kind: 'plugin', path: plugin } : null;
}

// READ_ONLY drops user settings, so the plugin is not loaded: point at its SKILL.md instead.
// ponytail: newest version by name sort. Ceiling: "4.10" sorts before "4.9". Upgrade: semver compare.
function pluginSkill() {
  const ls = (p) => { try { return readdirSync(p).sort().reverse(); } catch { return []; } };
  const cache = join(homedir(), '.claude/plugins/cache');
  for (const market of ls(cache)) for (const plugin of ls(join(cache, market))) for (const ver of ls(join(cache, market, plugin))) {
    const path = join(cache, market, plugin, ver, 'skills/ponytail-review/SKILL.md');
    if (existsSync(path)) return path;
  }
  return null;
}

export function resolveRunner(conf = {}, env = process.env) {
  const name = env.PENEIRA_RUNNER || conf.runner || 'claude';
  const spec = RUNNERS[name];
  if (!spec) throw new Error(`Unknown runner "${name}" (claude, cursor, codex)`);
  return { name, spec, bin: env[spec.binEnv] || spec.bin };
}

export function binaryExists(bin, env) {
  if (bin.includes('/')) return existsSync(bin);
  return spawnSync('sh', ['-c', `command -v ${JSON.stringify(bin)}`], { env, stdio: 'ignore' }).status === 0;
}

export function available({ cwd, conf = {}, env = process.env }) {
  if (!skillSource(cwd)) return { ok: false, reason: 'ponytail-review skill not found. Run `peneira init --with-ponytail` or install the ponytail plugin in Claude Code.' };
  let runner;
  try { runner = resolveRunner(conf, env); }
  catch (e) { return { ok: false, reason: e.message }; }
  if (!binaryExists(runner.bin, env)) return { ok: false, reason: `${runner.spec.label} is not installed` };
  return { ok: true };
}

export function buildPrompt({ src, base, head }) {
  return `Read ${src.path} and follow it exactly.
Review the change between ${base} and ${head}: start with \`git diff ${base}...${head}\`,
then read the code it touches as the skill says. Do not modify any file.
Only flag code this change adds or modifies. Zero findings is a good answer.

Write the report in the format the skill describes.
After the report, append ONE fenced \`\`\`json block containing the same findings, with the
same numbers, matching this shape (group: must = Must fix, should = Should fix, nice = Nice to have;
line numbers refer to the NEW version of the file):
${SCHEMA}`;
}

export function parse(text, { prefix, source }) {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) throw new Error('ponytail output has no JSON block');
  const data = JSON.parse(blocks.at(-1)[1]);
  const findings = (data.findings || []).map((f, i) => makeFinding({
    id: `${prefix}${f.number ?? i + 1}`,
    source,
    group: f.group,
    title: f.title,
    file: f.file,
    line: f.line_start,
    endLine: f.line_end,
    parts: { Problem: f.problem, Fix: f.fix },
  }));
  const intro = [
    data.what_this_change_does && `**What this change does:** ${data.what_this_change_does}`,
    data.not_checked && `**Not checked:** ${data.not_checked}`,
  ].filter(Boolean).join('\n\n');
  return { findings, intro, report: text.slice(0, blocks.at(-1).index).trim(), meta: { verdict: data.verdict, lean: data.lean } };
}

function argsFor(name, { prompt, conf, cwd, model, outFile }) {
  if (name === 'claude') {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', String(conf.maxTurns ?? 40),
      ...READ_ONLY,
      '--allowedTools', 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git grep:*)',
      '--disallowedTools', 'Edit,Write,NotebookEdit',
    ];
    if (model) args.push('--model', model);
    return args;
  }
  // ponytail: Cursor ask mode and the Codex read-only sandbox may refuse `git`. Ceiling: the prompt only points at the skill and the code it names. Upgrade: prepend `git diff --stat` to the prompt; do not loosen the sandbox.
  if (name === 'cursor') {
    const args = ['-p', '--mode', 'ask', '--trust', '--output-format', 'json', '--workspace', cwd];
    if (model) args.push('--model', model);
    args.push(prompt);
    return args;
  }
  const args = ['exec', '--sandbox', 'read-only', '--ephemeral', '-C', cwd, '-o', outFile];
  if (model) args.push('--model', model);
  args.push(prompt);
  return args;
}

export function capture(bin, args, { cwd, env, label }) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (e) => reject(new Error(`could not start ${label} (${bin}): ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${label} exited ${code}: ${(stderr || stdout).slice(0, 400)}`))));
  });
}

export async function run({ name, conf, cwd, base, head, env = process.env }) {
  const src = skillSource(cwd);
  if (!src) throw new Error(available({ cwd, conf, env }).reason);
  const runner = resolveRunner(conf, env);
  const model = env.PONYTAIL_MODEL || conf.model;
  const prompt = buildPrompt({ src, base, head });
  let dir = null;
  let outFile = null;
  if (runner.name === 'codex') {
    dir = mkdtempSync(join(tmpdir(), 'peneira-codex-'));
    outFile = join(dir, 'last.txt');
  }
  let text;
  try {
    const stdout = await capture(runner.bin, argsFor(runner.name, { prompt, conf, cwd, model, outFile }), { cwd, env, label: runner.spec.label });
    if (outFile) {
      if (!existsSync(outFile)) throw new Error('Codex wrote no final message');
      text = readFileSync(outFile, 'utf8');
    } else {
      try { text = JSON.parse(stdout).result ?? stdout; } catch { text = stdout; }
    }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  return { ...parse(text, { prefix: conf.prefix || 'P', source: name }), title: '🧑‍🦳 ponytail-review' };
}
