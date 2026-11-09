import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePrRef } from '../src/pr.mjs';
import { parseRepoFromRemote } from '../src/github.mjs';
import { loadConfig, DEFAULTS, ensureUserConfig } from '../src/config.mjs';
import { findSkill, installHint, resolveReviewSkill } from '../src/reviewers/skills.mjs';
import { runPolicy } from '../src/policy.mjs';
import { git } from '../src/git.mjs';
import { makeFinding, fromSarif, toSarif, dedupeFindings } from '../src/findings.mjs';
import { readStore, MARKERS, withData } from '../src/store.mjs';
import { diffIndex } from '../src/diffindex.mjs';
import { buildPublication } from '../src/publish.mjs';
import { parseDecisionSpec, applyDecisionSpec } from '../src/triage.mjs';
import { plannedReviewers } from '../src/reviewers/index.mjs';
import { available as llmAvailable } from '../src/reviewers/llm.mjs';
import { fixtureRepo } from './helpers.mjs';

test('PR refs: number, #number, URL; garbage is rejected', () => {
  assert.equal(parsePrRef('14'), 14);
  assert.equal(parsePrRef('#14'), 14);
  assert.equal(parsePrRef(14), 14);
  assert.equal(parsePrRef('https://github.com/o/r/pull/14/files'), 14);
  assert.equal(parsePrRef('abc'), null);
  assert.equal(parsePrRef(undefined), null);
});

test('repo is parsed from ssh and https remotes', () => {
  assert.equal(parseRepoFromRemote('git@github.com:o/r.git'), 'o/r');
  assert.equal(parseRepoFromRemote('https://github.com/o/r'), 'o/r');
  assert.equal(parseRepoFromRemote('https://gitlab.com/o/r'), null);
});

test('config: repo file overrides defaults, arrays replace', () => {
  const { cwd } = fixtureRepo({ config: { budget: { maxFiles: 3 }, ignore: ['x'] } });
  const cfg = loadConfig(cwd);
  assert.equal(cfg.budget.maxFiles, 3);
  assert.equal(cfg.budget.maxLogicLines, DEFAULTS.budget.maxLogicLines);
  assert.deepEqual(cfg.ignore, ['x']);
});

test('config: the bundled skill is the default, ~/.peneira/config.json sets the list, the repo file replaces it', () => {
  const home = mkdtempSync(join(tmpdir(), 'rg-home-'));
  ensureUserConfig({ HOME: home });
  const bare = fixtureRepo();
  assert.deepEqual(loadConfig(bare.cwd, { HOME: home }).reviewers.llm.skills, ['high-signal-review']);
  const over = fixtureRepo({ config: { reviewers: { llm: { skills: ['only-repo'] } } } });
  assert.deepEqual(loadConfig(over.cwd, { HOME: home }).reviewers.llm.skills, ['only-repo']);
  const skill = join(bare.cwd, '.agents/skills/code-review/SKILL.md');
  mkdirSync(join(skill, '..'), { recursive: true });
  writeFileSync(skill, '---\nname: code-review\n---\n');
  assert.equal(findSkill('code-review', bare.cwd, {}), skill);
  assert.equal(findSkill('missing', bare.cwd, { HOME: home }), null);
  assert.match(findSkill('high-signal-review', bare.cwd, {}), /templates\/skills\/high-signal-review\/SKILL\.md$/, 'bundled skill needs no install');
  const custom = join(bare.cwd, '.agents/skills/my-review/SKILL.md');
  mkdirSync(join(custom, '..'), { recursive: true });
  writeFileSync(custom, '---\nname: my-review\n---\n');
  assert.equal(resolveReviewSkill(['the-judge', 'my-review'], bare.cwd, {}).path, custom);
  const hint = installHint(['the-judge']);
  assert.match(hint, /the-judge/);
  assert.match(hint, /\.agents\/skills\/the-judge\/SKILL\.md/);
  assert.match(installHint(['code-review']), /npx skills add mattpocock\/skills/);
  assert.equal(installHint([]), null);
});

test('policy: classifies files, detects AI, blocks on unjustified dependency and empty sections', () => {
  const { cwd, baseSha, headSha } = fixtureRepo();
  const body = '## Intent\nPLAT-482\n## Assumptions\n<!-- todo -->\n## Out of scope / not done\nNothing\n## How it was verified\ntests';
  const r = runPolicy({ cwd, cfg: loadConfig(cwd), pr: { baseSha, headSha, title: 'x', body, headRef: 'claude/plat-482-dedupe', labels: [] } });
  const cat = Object.fromEntries(r.readingOrder.map((f) => [f.path, f.category]));
  assert.equal(cat['src/util/format.js'], 'mechanical');
  assert.equal(cat['src/util/renamed.js'], 'mechanical');
  assert.equal(cat['package-lock.json'], 'ignored');
  assert.equal(cat['migrations/0042_dedupe.sql'], 'foundation');
  assert.equal(r.readingOrder[0].path, 'migrations/0042_dedupe.sql');
  assert.equal(r.ticket, 'PLAT-482');
  assert.ok(r.isAI);
  assert.ok(r.highRisk);
  assert.equal(r.status, 'blocked');
  assert.ok(r.blocking.some((m) => m.includes('Assumptions')));
  assert.ok(r.blocking.some((m) => m.includes('p-retry')));
  assert.deepEqual(r.labels, ['ai-generated', 'risk:high']);
});

test('policy: required sections come from the repo PR template, in any heading style', () => {
  const { cwd, baseSha, headSha } = fixtureRepo();
  const pr = { baseSha, headSha, title: 'PLAT-482', headRef: 'x', labels: [] };
  const sectionsMsg = (r) => [...r.blocking, ...r.warnings].find((m) => m.startsWith('PR description'));
  const missing = (body) => sectionsMsg(runPolicy({ cwd, cfg: loadConfig(cwd), pr: { ...pr, body } }));
  assert.match(missing(''), /: Intent, Assumptions, Out of scope \/ not done, How it was verified \(from \.github\/pull_request_template\.md\)/);
  // Bold-line headings count, and a subheading stays inside its section.
  const body = '# Intent\nwhy\n**Assumptions**\nnone\n## Out of scope / not done\n### Details\nnothing\n## How it was verified\n**Unit tests**\npass';
  assert.equal(missing(body), undefined);

  const own = fixtureRepo();
  git(own.cwd, 'checkout', '-q', 'main');
  writeFileSync(join(own.cwd, '.github/pull_request_template.md'), '### → What this fixes\n<!-- bug or feature -->\n### → Notes\n<!-- Optional -->\n');
  git(own.cwd, 'commit', '-qam', 'own template');
  const r = runPolicy({ cwd: own.cwd, cfg: loadConfig(own.cwd), pr: { ...pr, baseSha: git(own.cwd, 'rev-parse', 'HEAD').trim(), headSha: own.headSha, body: '### → What this fixes\nA label bug.' } });
  assert.equal(sectionsMsg(r), undefined);
});

test('findings: fingerprint is stable across ids and line moves; SARIF round-trips', () => {
  const a = makeFinding({ id: 'P1', source: 'ponytail', group: 'must', title: 'Retries  insert duplicates!', file: './src/a.js', line: 3 });
  const b = makeFinding({ id: 'P7', source: 'ponytail', group: 'should', title: 'retries insert duplicates', file: 'src/a.js', line: 9 });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.file, 'src/a.js');
  const back = fromSarif(toSarif([a]), { source: 'x', prefix: 'S' });
  assert.equal(back[0].file, 'src/a.js');
  assert.equal(back[0].line, 3);
  assert.equal(back[0].group, 'must');
});

test('store: reads reviewer data and per-user triage decisions from comments', () => {
  const comments = [
    { body: `${MARKERS.reviewer('ponytail')}\n${withData('x', { headSha: 'abc', findings: [] })}` },
    { body: `${MARKERS.triage('leo')}\n${withData('y', { decisions: { f1: { decision: 'ignored' } } })}` },
    { body: 'unrelated' },
  ];
  const s = readStore(comments);
  assert.equal(s.reviewers.ponytail.headSha, 'abc');
  assert.equal(s.triage.leo.f1.decision, 'ignored');
});

test('publish (decision 8): inline when on a diff line, file comment when submitting, body when pending', () => {
  const { cwd, baseSha, headSha } = fixtureRepo();
  const index = diffIndex(cwd, baseSha, headSha);
  const f = (id, file, line, endLine) => makeFinding({ id, source: 'p', group: 'must', title: id, file, line, endLine, parts: { Problem: 'p' } });
  const choices = [
    { finding: f('ON', 'src/ingestion/worker.js', 2, 3), decision: 'commented', text: '**ON**' },
    { finding: f('OFF', 'src/ingestion/worker.js', 35), decision: 'commented', text: '**OFF**' },
    { finding: f('NOFILE', null, null), decision: 'commented', text: '**NOFILE**' },
    { finding: f('GEN', 'test/worker.test.js', 1), decision: 'general-note', text: '**GEN**' },
    { finding: f('IGN', 'test/worker.test.js', 1), decision: 'ignored' },
  ];

  const submit = buildPublication({ choices, index, mode: 'comment', commitId: headSha });
  assert.equal(submit.review.comments.length, 1);
  assert.deepEqual(submit.review.comments[0], { path: 'src/ingestion/worker.js', start_line: 2, start_side: 'RIGHT', line: 3, side: 'RIGHT', body: '**ON**' });
  assert.deepEqual(submit.fileComments.map((c) => c.body), ['**OFF**']);
  assert.equal(submit.review.event, 'COMMENT');
  assert.match(submit.review.body, /NOFILE/);
  assert.match(submit.review.body, /GEN/);
  assert.doesNotMatch(submit.review.body, /IGN|OFF/);

  const pending = buildPublication({ choices, index, mode: 'pending', commitId: headSha });
  assert.equal(pending.fileComments.length, 0);
  assert.equal(pending.review.event, undefined);
  assert.match(pending.review.body, /OFF.*worker\.js:35/);
  assert.deepEqual(pending.movedToBody.map((x) => x.id), ['OFF']);
});

test('decision spec: parses, applies, rejects unknown ids', () => {
  const q = [makeFinding({ id: 'P1', source: 'p', title: 'a' }), makeFinding({ id: 'A2', source: 'a', title: 'b' })];
  const out = applyDecisionSpec(q, parseDecisionSpec('P1=c, a2=f:unreachable'));
  assert.equal(out[0].decision, 'commented');
  assert.ok(out[0].text);
  assert.equal(out[1].decision, 'false-positive');
  assert.equal(out[1].reason, 'unreachable');
  assert.throws(() => applyDecisionSpec(q, parseDecisionSpec('Z9=c')), /Unknown finding/);
  assert.throws(() => parseDecisionSpec('P1=x'), /Bad decision/);
});

test('dedupeFindings: earlier reviewer wins on overlapping lines, keeps the worse group', () => {
  const a = makeFinding({ id: 'A1', source: 'llm', group: 'nice', title: 'Off-by-one in loop', file: 'src/x.js', line: 10, endLine: 12 });
  const p = makeFinding({ id: 'P1', source: 'ponytail', group: 'must', title: 'Remove manual loop', file: 'src/x.js', line: 13 });
  const far = makeFinding({ id: 'P2', source: 'ponytail', title: 'Dead helper', file: 'src/x.js', line: 40 });
  const same = makeFinding({ id: 'A2', source: 'llm', title: 'Second llm issue', file: 'src/x.js', line: 11 });
  const out = dedupeFindings([a, same, p, far]);
  assert.deepEqual(out.map((f) => f.id), ['A1', 'A2', 'P2']);
  assert.equal(out[0].group, 'must');
  assert.match(out[0].parts['Also flagged by'], /ponytail P1: Remove manual loop/);
  assert.equal(a.group, 'nice', 'input is not mutated');
  assert.deepEqual(out[0].alsoBy, ['ponytail'], 'absorbed sources are kept for metrics');
});

test('plannedReviewers: a reviewer whose prefix is taken uses its own name', () => {
  const cfg = { reviewers: {
    llm: { type: 'llm', prefix: 'A' }, builtin: { type: 'llm', prefix: 'A' }, quality: { type: 'llm', prefix: 'Q' }, ponytail: { type: 'ponytail' },
  } };
  assert.deepEqual(plannedReviewers(cfg, {}).map((r) => r.conf.prefix), ['A', 'BUILTIN', 'Q', 'P']);
});

test('plannedReviewers: compare reviewers run only with --compare or --only', () => {
  const cfg = { reviewers: { llm: { type: 'llm' }, quality: { type: 'llm', compare: true } } };
  assert.deepEqual(plannedReviewers(cfg, {}).map((r) => r.name), ['llm']);
  assert.deepEqual(plannedReviewers(cfg, {}, null, true).map((r) => r.name), ['llm', 'quality']);
  assert.deepEqual(plannedReviewers(cfg, {}, ['quality']).map((r) => r.name), ['quality']);
});

test('llm available: a compare reviewer without its skill is skipped, not run on the built-in prompt', () => {
  const { cwd } = fixtureRepo();
  const env = { REVIEW_API_KEY: 'k', HOME: cwd };
  assert.match(llmAvailable({ cwd, env, conf: { compare: true, skills: ['nope'], transport: 'agent' } }).reason, /skill not found: nope/);
  assert.match(llmAvailable({ cwd, env, conf: { compare: true, skills: ['high-signal-review'], transport: 'api', model: 'm' } }).reason, /HTTP API/);
  assert.equal(llmAvailable({ cwd, env, conf: { compare: true, skills: [], transport: 'api', model: 'm' } }).ok, true, 'builtin still runs');
});
