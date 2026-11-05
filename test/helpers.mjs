import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { scriptedIO } from '../src/ui.mjs';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (root, files) => {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
};

// 35 lines: 4 lines of logic, 30 fillers, an export on line 35 (far from any hunk).
const workerFile = (head) => [...head, ...Array.from({ length: 30 }, (_, i) => `// filler ${i}`), 'export const tail = 1;', ''].join('\n');

/** A repo with main + a feature branch that looks like an AI-written PR. */
/** @param {{config?: object}} [opts] */
export function fixtureRepo({ config } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'rg-repo-'));
  sh(cwd, 'init', '-q', '-b', 'main');
  sh(cwd, 'config', 'user.email', 't@t');
  sh(cwd, 'config', 'user.name', 't');
  sh(cwd, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  write(cwd, {
    'package.json': '{"name":"x","dependencies":{"pg":"8.0.0"}}\n',
    'src/util/format.js': 'export function a(x){\n  return x+1\n}\n',
    'src/util/old.js': 'old\n',
    'src/ingestion/worker.js': workerFile(['export const run = () => 1;', '', '', '']),
    ...(config ? { '.peneira/config.json': JSON.stringify(config) } : {}),
  });
  sh(cwd, 'add', '-A');
  sh(cwd, 'commit', '-qm', 'init');
  const baseSha = sh(cwd, 'rev-parse', 'HEAD');
  sh(cwd, 'checkout', '-qb', 'claude/plat-482-dedupe');
  write(cwd, {
    'package.json': '{"name":"x","dependencies":{"pg":"8.1.0","p-retry":"6.2.0"}}\n',
    'src/util/format.js': 'export function a(x){\n    return x+1\n}\n',
    'migrations/0042_dedupe.sql': 'ALTER TABLE events ADD COLUMN dedupe_key String;\n',
    'src/ingestion/worker.js': workerFile([
      'export const run = async (batch) => {',
      '  const retries = 3;',
      '  for (const e of batch) await insert(e);',
      '};',
    ]),
    'test/worker.test.js': 'test("dedupe", () => {});\n',
    'package-lock.json': Array.from({ length: 30 }, (_, i) => `x${i}`).join('\n'),
  });
  sh(cwd, 'mv', 'src/util/old.js', 'src/util/renamed.js');
  sh(cwd, 'add', '-A');
  sh(cwd, 'commit', '-qm', 'PLAT-482 dedupe events\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  const headSha = sh(cwd, 'rev-parse', 'HEAD');
  return { cwd, baseSha, headSha };
}

/** In-memory GitHub REST API good enough for peneira. */
/** @param {{baseSha?:string, headSha?:string, number?:number, body?:string, login?:string, comments?:any[]}} [opts] */
export function fakeGitHub({ baseSha, headSha, number = 7, body = '', login = 'leo', comments = [] } = {}) {
  const state = {
    comments: comments.map((c, i) => ({ id: i + 1, ...c })),
    reviews: [], fileComments: [], labels: [], calls: [], nextId: 100, pendingExists: false,
  };
  const pr = {
    number, title: 'PLAT-482 Dedupe events', body, user: { login: 'claude-bot' }, draft: false, labels: [],
    head: { ref: 'claude/plat-482-dedupe', sha: headSha }, base: { ref: 'main', sha: baseSha },
    html_url: `https://github.com/o/r/pull/${number}`,
  };
  const json = (x, status = 200) => new Response(status === 204 ? null : JSON.stringify(x), { status });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    const path = u.pathname;
    state.calls.push(`${method} ${path}${u.search}`);
    if (u.host !== 'api.github.com') return state.external ? state.external(url, opts) : json({ error: 'no route' }, 500);
    if (method === 'GET' && path === '/user') return json({ login });
    if (method === 'GET' && path === `/repos/o/r/pulls/${number}`) return json(pr);
    if (method === 'GET' && path === '/repos/o/r/pulls') return json(u.searchParams.get('head') === `o:${pr.head.ref}` ? [pr] : []);
    if (method === 'GET' && path === `/repos/o/r/issues/${number}/comments`) return json(u.searchParams.get('page') === '1' ? state.comments : []);
    if (method === 'POST' && path === `/repos/o/r/issues/${number}/comments`) {
      const c = { id: state.nextId++, body: body.body };
      state.comments.push(c);
      return json(c, 201);
    }
    if (method === 'PATCH' && path.startsWith('/repos/o/r/issues/comments/')) {
      const c = state.comments.find((x) => x.id === Number(path.split('/').pop()));
      c.body = body.body;
      return json(c);
    }
    if (method === 'POST' && path === `/repos/o/r/pulls/${number}/reviews`) {
      if (state.pendingExists && !body.event) return json({ message: 'User can only have one pending review per pull request' }, 422);
      state.reviews.push(body);
      if (!body.event) state.pendingExists = true;
      return json({ id: state.nextId++, html_url: `${pr.html_url}#pullrequestreview-1` }, 200);
    }
    if (method === 'POST' && path === `/repos/o/r/pulls/${number}/comments`) {
      state.fileComments.push(body);
      return json({ id: state.nextId++ }, 201);
    }
    if (method === 'POST' && path === `/repos/o/r/issues/${number}/labels`) { state.labels.push(...body.labels); return json([]); }
    if (method === 'DELETE' && path.startsWith('/repos/o/r/issues/comments/')) {
      const id = Number(path.split('/').pop());
      state.comments = state.comments.filter((c) => c.id !== id);
      return json(null, 204);
    }
    if (method === 'DELETE' && path.startsWith(`/repos/o/r/issues/${number}/labels/`)) return json(null, 204);
    return json({ message: `no route ${method} ${path}` }, 404);
  };
  return { state, pr, fetchImpl };
}

/** A fake `claude` binary that prints a ponytail-style report and counts its invocations. */
/** @param {object[]} findings @param {{counterFile?: string}} [opts] */
export function fakeClaude(findings, { counterFile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rg-bin-'));
  const bin = join(dir, 'claude');
  const data = { what_this_change_does: 'Adds a dedupe column and changes the worker.', verdict: 'fix 1 first', findings };
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
${counterFile ? `fs.appendFileSync(${JSON.stringify(counterFile)}, 'x');` : ''}
const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';
if (!/ponytail-review/.test(prompt)) { console.error('no skill in prompt'); process.exit(3); }
const result = 'What this change does: ...\\n\\n\`\`\`json\\n' + ${JSON.stringify(JSON.stringify(data))} + '\\n\`\`\`';
console.log(JSON.stringify({ type: 'result', result }));
`);
  chmodSync(bin, 0o755);
  return bin;
}

export const PONYTAIL_FINDINGS = [
  { number: 1, group: 'must', title: 'Retries insert duplicates', file: 'src/ingestion/worker.js', line_start: 2, line_end: 3,
    what_this_is: 'Worker inserts a batch.', problem: 'A retry re-inserts the whole batch.', fix: 'Insert with dedupe_key.', if_we_skip_it: 'Counts drift.' },
  { number: 2, group: 'should', title: 'Empty test', file: 'test/worker.test.js', line_start: 1, line_end: null,
    what_this_is: 'Test file.', problem: 'No assertion.', fix: 'Assert one row after duplicate delivery.', if_we_skip_it: 'Bug ships.' },
  { number: 3, group: 'nice', title: 'Tail export unused', file: 'src/ingestion/worker.js', line_start: 35, line_end: null,
    what_this_is: 'Export.', problem: 'Never imported.', fix: 'Delete it.', if_we_skip_it: 'Dead code.' },
  { number: 4, group: 'nice', title: 'Helper name is vague', file: 'src/util/format.js', line_start: 1, line_end: null,
    what_this_is: 'Helper.', problem: 'Name a() says nothing.', fix: 'Rename.', if_we_skip_it: 'Harder to read.' },
];

export function withSkill(cwd) {
  write(cwd, { '.agents/skills/ponytail-review/SKILL.md': '---\nname: ponytail-review\n---\nReview.\n' });
}

export { scriptedIO };
