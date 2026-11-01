import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { makeFinding } from '../src/findings.mjs';
import { MARKERS, withData, readStore } from '../src/store.mjs';
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
const realFetch = globalThis.fetch;
function withFetch(fn) { return async (t) => { const s = setup(t.setupOpts); globalThis.fetch = s.gh.fetchImpl; try { await fn(s); } finally { globalThis.fetch = realFetch; } }; }

test('peneira 7 --decide: runs both reviewers locally, posts separate inline threads, remembers decisions', withFetch(async (s) => {
  const io = scriptedIO([]);
  const code = await s.run(['7', '--decide', 'P1=c,P2=c,A1=i,P4=f:helper is fine', '--submit', 'pending'], io);
  assert.equal(code, 0, io.log.join('\n'));
  assert.equal(s.claudeCalls(), 1);
  assert.equal(s.gh.state.llmCalls, 1);

  const [review] = s.gh.state.reviews;
  assert.equal(review.event, undefined, 'pending review');
  assert.equal(review.commit_id, s.repo.headSha);
  assert.deepEqual(review.comments.map((c) => [c.path, c.start_line ?? null, c.line]),
    [['src/ingestion/worker.js', 2, 3], ['test/worker.test.js', null, 1]], 'one thread per finding, anchored');
  assert.match(review.comments[0].body, /Retries insert duplicates/);
  assert.equal(review.body, undefined, 'nothing forced into the review body');

  const store = readStore(s.gh.state.comments);
  const decisions = Object.values(store.triage.leo);
  assert.deepEqual(decisions.map((d) => d.decision).sort(), ['commented', 'commented', 'false-positive', 'ignored']);
  assert.ok(!s.gh.state.comments.some((c) => /Retries insert duplicates/.test(c.body)), 'triage log does not leak finding titles');

  // second run: the cache prevents re-running reviewers, decided findings are not asked again
  const io2 = scriptedIO([]);
  await s.run(['7', '--list'], io2);
  assert.equal(s.claudeCalls(), 1, 'ponytail reused from cache');
  assert.equal(s.gh.state.llmCalls, 1, 'llm reused from cache');
  const listed = io2.log.filter((l) => /^(P|A)\d/.test(l)).map((l) => l.split(' ')[0]);
  assert.deepEqual(listed.sort(), ['A2', 'P3']);
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
  const d = Object.values(readStore(s.gh.state.comments).triage.leo);
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
  assert.ok(!s.gh.state.calls.some((c) => c.startsWith('POST') || c.startsWith('PATCH')));
  assert.ok(io.log.some((l) => l.includes('[dry-run] would post')));
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
