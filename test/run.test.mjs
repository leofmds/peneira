import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitDir } from '../src/git.mjs';
import { main } from '../src/cli.mjs';
import { makeFinding } from '../src/findings.mjs';
import * as ponytail from '../src/reviewers/ponytail.mjs';
import * as llm from '../src/reviewers/llm.mjs';
import { MARKERS, withData } from '../src/store.mjs';
import { fixtureRepo, fakeGitHub, fakeClaude, withSkill, scriptedIO, PONYTAIL_FINDINGS } from './helpers.mjs';

const LLM_RESULT = {
  intent_match: { status: 'partial', notes: 'no dedupe on insert' },
  out_of_scope_files: [{ file: 'src/util/renamed.js', reason: 'Rename unrelated to PLAT-482.' }],
  unstated_assumptions: [], questions_for_author: [],
  findings: [{ severity: 'major', category: 'idempotency', file: 'src/ingestion/worker.js', line: 3, issue: 'No dedupe key check.', suggestion: 'Check dedupe_key.' }],
  tests: { covers_spec: true, notes: '' },
};

function setup({ comments = [], llm = true } = {}) {
  const repo = fixtureRepo({ config: { reviewers: { llm: { enabled: llm, model: 'test-model', runFor: 'all' } } } });
  withSkill(repo.cwd);
  const counter = join(mkdtempSync(join(tmpdir(), 'rg-c-')), 'calls');
  const gh = fakeGitHub({ baseSha: repo.baseSha, headSha: repo.headSha, comments });
  gh.state.external = async (url) => {
    if (String(url).includes('api.anthropic.com')) {
      gh.state.llmCalls = (gh.state.llmCalls || 0) + 1;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(LLM_RESULT) }] }), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  };
  const env = { GITHUB_TOKEN: 't', REVIEW_API_KEY: 'k', CLAUDE_BIN: fakeClaude(PONYTAIL_FINDINGS, { counterFile: counter }), PATH: process.env.PATH };
  const run = (argv, io = scriptedIO([])) => main(argv, { io, env, cwd: repo.cwd, fetchImpl: gh.fetchImpl });
  const claudeCalls = () => (existsSync(counter) ? readFileSync(counter, 'utf8').length : 0);
  return { repo, gh, env, run, claudeCalls };
}

// main() uses the real fetch; route it through the fake for these tests.
const triageFile = (repo) => join(gitDir(repo.cwd), 'peneira', '7', 'triage.json');

const realFetch = globalThis.fetch;
function withFetch(fn) { return async (t) => { const s = setup(t.setupOpts); globalThis.fetch = s.gh.fetchImpl; try { await fn(s); } finally { globalThis.fetch = realFetch; } }; }

test('peneira 7 --decide: runs both reviewers locally, merges duplicates, posts separate inline threads, remembers decisions', withFetch(async (s) => {
  const io = scriptedIO([]);
  const code = await s.run(['7', '--decide', 'A1=c,P2=c,A2=i,P4=f:helper is fine', '--submit', 'pending'], io);
  assert.equal(code, 0, io.log.join('\n'));
  assert.equal(s.claudeCalls(), 1);
  assert.equal(s.gh.state.llmCalls, 1);

  const [review] = s.gh.state.reviews;
  assert.equal(review.event, undefined, 'pending review');
  assert.equal(review.commit_id, s.repo.headSha);
  assert.deepEqual(review.comments.map((c) => [c.path, c.start_line ?? null, c.line]),
    [['src/ingestion/worker.js', null, 3], ['test/worker.test.js', null, 1]], 'one thread per finding, anchored');
  assert.match(review.comments[0].body, /No dedupe key check[\s\S]*Also flagged by:\*\* ponytail P1: Retries insert duplicates/, 'ponytail P1 merged into the llm finding');
  assert.ok(io.log.some((l) => l.includes('1 duplicate finding(s) merged')));
  assert.equal(review.body, undefined, 'nothing forced into the review body');

  const decisions = Object.values(JSON.parse(readFileSync(triageFile(s.repo), 'utf8')));
  assert.deepEqual(decisions.map((d) => d.decision).sort(), ['commented', 'commented', 'false-positive', 'ignored']);
  assert.ok(!s.gh.state.comments.some((c) => c.body?.startsWith(MARKERS.triage('leo'))), 'triage is not posted on the PR');
  assert.ok(!s.gh.state.comments.some((c) => /Retries insert duplicates/.test(c.body)), 'triage log does not leak finding titles');

  // second run: the cache prevents re-running reviewers, decided findings are not asked again
  const io2 = scriptedIO([]);
  await s.run(['7', '--list'], io2);
  assert.equal(s.claudeCalls(), 1, 'ponytail reused from cache');
  assert.equal(s.gh.state.llmCalls, 1, 'llm reused from cache');
  const listed = io2.log.filter((l) => /^(P|A)\d/.test(l)).map((l) => l.split(' ')[0]);
  assert.deepEqual(listed.sort(), ['P3']);

  // --all brings back ignored/false-positive findings, but not the ones already posted
  const io3 = scriptedIO([]);
  await s.run(['7', '--list', '--all'], io3);
  const all = io3.log.filter((l) => /^(P|A)\d/.test(l)).map((l) => l.split(' ')[0]);
  assert.deepEqual(all.sort(), ['A2', 'P3', 'P4']);
}));

test('reuses CI results for the same head commit instead of running locally', withFetch(async (s) => {
  const ci = [makeFinding({ id: 'P1', source: 'ponytail', group: 'must', title: 'From CI', file: 'src/ingestion/worker.js', line: 2, parts: { Problem: 'x' } })];
  s.gh.state.comments.push({ id: 1, body: `${MARKERS.reviewer('ponytail')}\n${withData('summary', { headSha: s.repo.headSha, findings: ci })}` });
  const io = scriptedIO([]);
  await s.run(['#7', '--list', '--only', 'ponytail'], io);
  assert.equal(s.claudeCalls(), 0);
  assert.ok(io.log.some((l) => l.includes('ponytail: 1 finding(s) [CI]')), io.log.join('\n'));
  assert.ok(io.log.some((l) => l.includes('From CI')));
}));

test('stale CI results (older head) are ignored and the reviewer runs locally', withFetch(async (s) => {
  s.gh.state.comments.push({ id: 1, body: `${MARKERS.reviewer('ponytail')}\n${withData('x', { headSha: 'deadbeef', findings: [] })}` });
  await s.run(['7', '--list', '--only', 'ponytail']);
  assert.equal(s.claudeCalls(), 1);
}));

test('interactive: back, edit, false positive, then submit -> off-diff finding becomes a file comment', withFetch(async (s) => {
  // P1 c, back to P1 and c again, P2 edit, P3 c (off-diff), P4 false positive, submit as comment
  const io = scriptedIO(['c', 'b', 'c', 'e', 'EDIT:**Empty test**\n\nPlease assert one row after a duplicate.', 'c', 'f', 'it is used by the CLI', 'c']);
  io.interactive = true;
  const code = await s.run(['7', '--only', 'ponytail'], io);
  assert.equal(code, 0, io.log.join('\n'));
  const [review] = s.gh.state.reviews;
  assert.equal(review.event, 'COMMENT');
  assert.equal(review.comments.length, 2);
  assert.match(review.comments[1].body, /Please assert one row/);
  assert.deepEqual(s.gh.state.fileComments.map((c) => [c.path, c.subject_type]), [['src/ingestion/worker.js', 'file']]);
  assert.match(s.gh.state.fileComments[0].body, /Tail export unused/);
  const d = Object.values(JSON.parse(readFileSync(triageFile(s.repo), 'utf8')));
  assert.equal(d.find((x) => x.id === 'P4').reason, 'it is used by the CLI');
  assert.equal(d.find((x) => x.id === 'P2').decision, 'commented-edited');
}));

test('no PR number: resolves the open PR of the current branch', withFetch(async (s) => {
  const io = scriptedIO([]);
  await s.run(['--list', '--only', 'ponytail'], io);
  assert.ok(io.log[0].startsWith('PR #7'), io.log[0]);
}));

test('without a terminal and without --decide it explains what to do', withFetch(async (s) => {
  const io = scriptedIO([]);
  const code = await s.run(['7', '--only', 'ponytail'], io);
  assert.equal(code, 1);
  assert.ok(io.log.some((l) => l.includes('use --list to see findings and --decide')));
}));

test('a second pending review is reported clearly', withFetch(async (s) => {
  s.gh.state.pendingExists = true;
  const io = scriptedIO([]);
  const code = await s.run(['7', '--only', 'ponytail', '--decide', 'P1=c'], io);
  assert.equal(code, 1);
  assert.ok(io.log.some((l) => l.includes('already have a pending review')));
}));

test('--dry-run prints the payload and writes nothing to GitHub', withFetch(async (s) => {
  const io = scriptedIO([]);
  await s.run(['7', '--only', 'ponytail', '--decide', 'P1=c', '--dry-run'], io);
  assert.equal(s.gh.state.reviews.length, 0);
  assert.ok(!s.gh.state.calls.some((c) => c.startsWith('POST') || c.startsWith('PATCH') || c.startsWith('DELETE')));
  assert.equal(existsSync(triageFile(s.repo)), false);
  assert.ok(io.log.some((l) => l.includes('[dry-run] would post')));
}));

test('an old triage comment is removed and its decisions still skip findings', withFetch(async (s) => {
  const f = makeFinding({ id: 'P1', source: 'ponytail', group: 'must', title: 'Retries insert duplicates', file: 'src/ingestion/worker.js', line: 2, parts: { Problem: 'x' } });
  s.gh.state.comments.push({ id: 9, body: `${MARKERS.triage('leo')}\n${withData('', { decisions: { [f.fingerprint]: { decision: 'ignored', id: 'P1' } } })}` });
  const io = scriptedIO([]);
  await s.run(['7', '--list', '--only', 'ponytail'], io);
  assert.ok(!s.gh.state.comments.some((c) => c.body?.startsWith(MARKERS.triage('leo'))));
  assert.ok(!io.log.some((l) => l.includes('Retries insert duplicates')));
  assert.equal(JSON.parse(readFileSync(triageFile(s.repo), 'utf8'))[f.fingerprint].decision, 'ignored');
}));

test('--list --json gives the /pr-review command everything it needs', withFetch(async (s) => {
  const io = scriptedIO([]);
  await s.run(['7', '--list', '--json', '--only', 'ponytail'], io);
  const json = JSON.parse(io.log.find((l) => l.startsWith('{')));
  assert.equal(json.pr.number, 7);
  assert.equal(json.gate.status, 'blocked');
  assert.deepEqual(json.findings.map((f) => f.id), ['P1', 'P2', 'P3', 'P4']);
  assert.deepEqual(Object.keys(json.findings[0].parts), ['What this is', 'Problem', 'Fix', 'If we skip it']);
}));

test('each runner: read-only flag, and its output becomes findings', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rg-runners-'));
  mkdirSync(join(cwd, '.agents/skills/ponytail-review'), { recursive: true });
  writeFileSync(join(cwd, '.agents/skills/ponytail-review/SKILL.md'), '---\nname: ponytail-review\n---\n');
  const log = join(cwd, 'argv.json');
  const data = { what_this_change_does: 'Adds a dedupe column.', verdict: 'fix 1 first', findings: PONYTAIL_FINDINGS };
  const text = `What this change does: ...\n\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\``;
  const bin = join(cwd, 'fake-agent');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(argv));
const text = ${JSON.stringify(text)};
const o = argv.indexOf('-o');
if (o >= 0) fs.writeFileSync(argv[o + 1], text);
else process.stdout.write(JSON.stringify({ result: text }));
`);
  chmodSync(bin, 0o755);
  const bins = { claude: 'CLAUDE_BIN', cursor: 'CURSOR_AGENT_BIN', codex: 'CODEX_BIN' };
  const readOnly = {
    claude: (argv) => argv[argv.indexOf('--disallowedTools') + 1] === 'Edit,Write,NotebookEdit',
    cursor: (argv) => argv[argv.indexOf('--mode') + 1] === 'ask',
    codex: (argv) => argv[argv.indexOf('--sandbox') + 1] === 'read-only',
  };
  for (const runner of ['claude', 'cursor', 'codex']) {
    const result = await ponytail.run({
      name: 'ponytail', conf: { runner, prefix: 'P' }, cwd, base: 'a', head: 'b',
      env: { [bins[runner]]: bin, PATH: process.env.PATH },
    });
    const argv = JSON.parse(readFileSync(log, 'utf8'));
    assert.ok(readOnly[runner](argv), argv.join(' '));
    assert.ok(argv.some((a) => a.includes('ponytail-review')));
    assert.equal(result.findings.length, 4);
    assert.equal(result.findings[0].id, 'P1');
    assert.equal(result.findings[0].title, 'Retries insert duplicates');
    if (runner === 'claude') assert.ok(argv.includes('--max-turns'));
    else assert.equal(argv.includes('--max-turns'), false);
    if (runner === 'codex') {
      assert.ok(argv.includes('--ephemeral'));
      assert.equal(existsSync(argv[argv.indexOf('-o') + 1]), false);
    }
  }
  await ponytail.run({
    name: 'ponytail', conf: { runner: 'claude', prefix: 'P' }, cwd, base: 'a', head: 'b',
    env: { PENEIRA_RUNNER: 'cursor', CURSOR_AGENT_BIN: bin, PATH: process.env.PATH },
  });
  const overridden = JSON.parse(readFileSync(log, 'utf8'));
  assert.equal(overridden[overridden.indexOf('--mode') + 1], 'ask');
  assert.equal(ponytail.available({ cwd, conf: { runner: 'claude' }, env: { CLAUDE_BIN: '/nonexistent/claude', PATH: process.env.PATH } }).ok, false);
});

test('llm agent transport: login locally, HTTP when the key or CI is present', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rg-llm-'));
  const log = join(cwd, 'argv.json');
  const bin = join(cwd, 'fake-agent');
  const payload = JSON.stringify(LLM_RESULT);
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(argv));
const text = ${JSON.stringify(payload)};
const o = argv.indexOf('-o');
if (o >= 0) fs.writeFileSync(argv[o + 1], text);
else process.stdout.write(JSON.stringify({ result: text }));
`);
  chmodSync(bin, 0o755);
  const bins = { claude: 'CLAUDE_BIN', cursor: 'CURSOR_AGENT_BIN', codex: 'CODEX_BIN' };
  const ctx = { name: 'llm', cwd, base: 'a', head: 'b', pr: { title: 'PLAT-482', body: '' }, report: { readingOrder: [] } };
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; throw new Error('http'); };

  for (const runner of ['claude', 'cursor', 'codex']) {
    fetches = 0;
    const result = await llm.run({
      ...ctx, conf: { runner, prefix: 'A', transport: 'auto' }, fetchImpl,
      env: { [bins[runner]]: bin, PATH: process.env.PATH },
    });
    const argv = JSON.parse(readFileSync(log, 'utf8'));
    assert.equal(fetches, 0);
    assert.equal(result.findings[0].id, 'A1');
    assert.equal(result.findings.length, 2);
    assert.match(result.title, new RegExp(`${runner} / default`));
    assert.equal(argv.includes('--model'), false);
    if (runner === 'claude') {
      assert.equal(argv[argv.indexOf('--tools') + 1], '');
      assert.equal(argv[argv.indexOf('--max-turns') + 1], '1');
      assert.match(argv[argv.indexOf('--system-prompt') + 1], /principal engineer/);
      assert.equal(argv.includes('--bare'), false);
      assert.equal(argv.includes('--allowedTools'), false);
      assert.match(argv[argv.indexOf('-p') + 1], /## DIFF/);
    } else if (runner === 'cursor') {
      assert.equal(argv[argv.indexOf('--mode') + 1], 'ask');
      assert.match(argv.at(-1), /## DIFF/);
    } else {
      assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
      assert.equal(existsSync(argv[argv.indexOf('-o') + 1]), false);
      assert.match(argv.at(-1), /## DIFF/);
    }
  }

  await llm.run({
    ...ctx, conf: { runner: 'claude', prefix: 'A' }, fetchImpl,
    env: { PENEIRA_RUNNER: 'cursor', REVIEW_MODEL: 'other-model', CURSOR_AGENT_BIN: bin, PATH: process.env.PATH },
  });
  const overridden = JSON.parse(readFileSync(log, 'utf8'));
  assert.equal(overridden[overridden.indexOf('--mode') + 1], 'ask');
  assert.equal(overridden[overridden.indexOf('--model') + 1], 'other-model');

  await llm.run({
    ...ctx, conf: { prefix: 'A' }, cfg: { reviewers: { ponytail: { runner: 'codex' } } }, fetchImpl,
    env: { CODEX_BIN: bin, PATH: process.env.PATH },
  });
  const fromPonytail = JSON.parse(readFileSync(log, 'utf8'));
  assert.equal(fromPonytail[fromPonytail.indexOf('--sandbox') + 1], 'read-only');

  const missing = { CLAUDE_BIN: '/nonexistent/claude', PATH: process.env.PATH };
  const present = { CLAUDE_BIN: bin, PATH: process.env.PATH };
  assert.equal(llm.available({ conf: { transport: 'auto' }, env: { ...present, GITHUB_ACTIONS: 'true' } }).ok, false);
  assert.match(llm.available({ conf: { transport: 'auto' }, env: { ...present, GITHUB_ACTIONS: 'true' } }).reason, /REVIEW_API_KEY/);
  assert.equal(llm.available({ conf: { transport: 'api' }, env: present }).ok, false);
  assert.equal(llm.available({ conf: { transport: 'agent' }, env: { ...missing, REVIEW_API_KEY: 'k' } }).ok, false);
  assert.equal(llm.available({ conf: { transport: 'api', model: 'm' }, env: { ...present, REVIEW_API_KEY: 'k' } }).ok, true);
  assert.equal(llm.available({ conf: { transport: 'nope' }, env: present }).ok, false);
  assert.match(llm.available({ conf: { runner: 'nope', transport: 'agent' }, env: present }).reason, /Unknown runner/);
});

test('llm uses the first installed review skill and does not post', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rg-llm-skill-'));
  mkdirSync(join(cwd, '.agents/skills/code-review'), { recursive: true });
  const skill = join(cwd, '.agents/skills/code-review/SKILL.md');
  writeFileSync(skill, '---\nname: code-review\n---\nReview.\n');
  const log = join(cwd, 'argv.json');
  const bin = join(cwd, 'fake-agent');
  const payload = `Notes.\n\`\`\`json\n${JSON.stringify(LLM_RESULT)}\n\`\`\``;
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ result: ${JSON.stringify(payload)} }));
`);
  chmodSync(bin, 0o755);
  let fetches = 0;
  const result = await llm.run({
    name: 'llm', cwd, base: 'a', head: 'b', pr: { title: 't', body: '' }, report: { readingOrder: [] },
    conf: { runner: 'claude', prefix: 'A', skills: ['code-review', 'requesting-code-review'], transport: 'auto' },
    env: { CLAUDE_BIN: bin, REVIEW_API_KEY: 'k', PATH: process.env.PATH },
    fetchImpl: async () => { fetches += 1; throw new Error('http'); },
  });
  const argv = JSON.parse(readFileSync(log, 'utf8'));
  assert.equal(fetches, 0);
  assert.equal(result.findings[0].id, 'A1');
  assert.equal(result.suggest, null);
  assert.match(result.title, /code-review/);
  assert.equal(result.skill, 'code-review');
  assert.equal(argv[argv.indexOf('--allowedTools') + 1].includes('Bash(git diff:*)'), true);
  assert.match(argv[argv.indexOf('-p') + 1], new RegExp(skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(argv[argv.indexOf('-p') + 1], /Do not post to GitHub/);
});
