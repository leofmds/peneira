// Adapter: ponytail-review skill (github.com/DietrichGebert/ponytail) run through Claude Code
// in headless mode. Uses the skill vendored in the repo if present, else the installed plugin.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeFinding } from '../findings.mjs';

export const REPO_SKILL = '.claude/skills/ponytail-review/SKILL.md';

const SCHEMA = `{
  "what_this_change_does": string,
  "verdict": string,
  "lean": string | null,
  "not_checked": string | null,
  "findings": [ { "number": number, "group": "must" | "should" | "nice", "title": string,
    "file": string | null, "line_start": number | null, "line_end": number | null,
    "what_this_is": string, "problem": string, "fix": string, "if_we_skip_it": string } ]
}`;

function skillSource(cwd) {
  if (existsSync(join(cwd, REPO_SKILL))) return { kind: 'repo', path: REPO_SKILL };
  const user = join(homedir(), '.claude/skills/ponytail-review/SKILL.md');
  if (existsSync(user)) return { kind: 'user', path: user };
  if (existsSync(join(homedir(), '.claude/plugins'))) return { kind: 'plugin' };
  return null;
}

export function available({ cwd }) {
  return skillSource(cwd) ? { ok: true }
    : { ok: false, reason: 'ponytail-review skill not found. Run `peneira init --with-ponytail` or install the ponytail plugin in Claude Code.' };
}

export function buildPrompt({ src, base, head }) {
  const how = src.path ? `Read ${src.path} and follow it exactly.` : 'Use the ponytail-review skill and follow it exactly.';
  return `${how}
Review the change between ${base} and ${head}: start with \`git diff ${base}...${head}\`,
then read the code it touches as the skill says. Do not modify any file.

Write the full report exactly as the skill's Output section describes.
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
    parts: { 'What this is': f.what_this_is, Problem: f.problem, Fix: f.fix, 'If we skip it': f.if_we_skip_it },
  }));
  const intro = [
    data.what_this_change_does && `**What this change does:** ${data.what_this_change_does}`,
    data.not_checked && `**Not checked:** ${data.not_checked}`,
  ].filter(Boolean).join('\n\n');
  return { findings, intro, report: text.slice(0, blocks.at(-1).index).trim(), meta: { verdict: data.verdict, lean: data.lean } };
}

export async function run({ name, conf, cwd, base, head, env = process.env }) {
  const src = skillSource(cwd);
  if (!src) throw new Error(available({ cwd }).reason);
  const args = [
    '-p', buildPrompt({ src, base, head }),
    '--output-format', 'json',
    '--max-turns', String(conf.maxTurns ?? 40),
    '--allowedTools', 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git grep:*)',
    '--disallowedTools', 'Edit,Write,NotebookEdit',
  ];
  const model = env.PONYTAIL_MODEL || conf.model;
  if (model) args.push('--model', model);

  const bin = env.CLAUDE_BIN || 'claude';
  const out = await new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (e) => reject(new Error(`could not start Claude Code (${bin}): ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`claude exited ${code}: ${(stderr || stdout).slice(0, 400)}`))));
  });
  let text = out;
  try { text = JSON.parse(out).result ?? out; } catch { /* plain text */ }
  return { ...parse(text, { prefix: conf.prefix || 'P', source: name }), title: '🧑‍🦳 ponytail-review' };
}
