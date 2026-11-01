import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { loadConfig } from '../src/config.mjs';
import { toSarif, makeFinding } from '../src/findings.mjs';
import { fixtureRepo, fakeGitHub, scriptedIO } from './helpers.mjs';

const emptyRepo = () => { const d = mkdtempSync(join(tmpdir(), 'rg-init-')); execFileSync('git', ['init', '-q'], { cwd: d }); return d; };
const fakeRaw = async (url) => new Response(String(url).endsWith('LICENSE') ? 'MIT License' : '---\nname: ponytail-review\n---\n', { status: 200 });

test('init: data-pipeline preset, ponytail vendored at the pinned commit, workflows wired', async () => {
  const cwd = emptyRepo();
  const urls = [];
  const io = scriptedIO([]);
  const code = await main(['init', '--preset', 'data-pipeline', '--with-ponytail', '--action-ref', 'acme/peneira@v0'],
    { io, cwd, env: {}, fetchImpl: async (u) => { urls.push(String(u)); return fakeRaw(u); } });
  assert.equal(code, 0, io.log.join('\n'));
  for (const f of ['.peneira/config.json', 'CLAUDE.md', '.github/pull_request_template.md', '.claude/commands/pr-review.md',
    '.claude/skills/ponytail-review/SKILL.md', '.claude/skills/ponytail-review/LICENSE', '.github/workflows/peneira-reviewers.yml']) {
    assert.ok(existsSync(join(cwd, f)), f);
  }
  assert.ok(urls.every((u) => u.includes('/DietrichGebert/ponytail/96608e078b2d5ea607c5c3b8b5a54d1c1fba6846/')));
  const wf = readFileSync(join(cwd, '.github/workflows/peneira-reviewers.yml'), 'utf8');
  assert.match(wf, /uses: acme\/peneira@v0/);
  assert.match(wf, /install-python-tools: 'semgrep'/);
  assert.doesNotMatch(wf, /__/);
  const cfg = loadConfig(cwd);
  assert.equal(cfg.reviewers.semgrep.type, 'sarif');
  assert.ok(cfg.risk.paths.includes('**/ingestion/**'));
  assert.equal(cfg.budget.maxLogicLines, 400, 'defaults still apply');
  assert.match(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), /Idempotency/);
});

test('init: never clobbers; existing CLAUDE.md gets a side file', async () => {
  const cwd = emptyRepo();
  writeFileSync(join(cwd, 'CLAUDE.md'), 'mine');
  await main(['init'], { io: scriptedIO([]), cwd, env: {} });
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), 'mine');
  assert.ok(existsSync(join(cwd, '.peneira/CLAUDE.peneira.md')));
  writeFileSync(join(cwd, '.peneira/config.json'), '{"budget":{"maxFiles":1}}');
  const io = scriptedIO([]);
  await main(['init'], { io, cwd, env: {} });
  assert.equal(readFileSync(join(cwd, '.peneira/config.json'), 'utf8'), '{"budget":{"maxFiles":1}}');
  assert.ok(io.log.some((l) => l.includes('.peneira/config.json (exists')));
});

test('sarif reviewer: any SARIF-emitting command becomes triageable findings, no core change', async () => {
  const repo = fixtureRepo({ config: { reviewers: {
    ponytail: { enabled: false }, llm: { enabled: false },
    lint: { type: 'sarif', prefix: 'S', command: 'cat .lint.sarif # {base} {head}' },
    missing: { type: 'sarif', command: 'nope', requires: 'definitely-not-installed-tool' },
  } } });
  const f = makeFinding({ id: 'x', source: 'eslint', group: 'should', title: 'no-unused-vars', file: 'src/ingestion/worker.js', line: 3, parts: { Problem: 'unused' } });
  writeFileSync(join(repo.cwd, '.lint.sarif'), JSON.stringify(toSarif([f], 'eslint')));
  const gh = fakeGitHub({ baseSha: repo.baseSha, headSha: repo.headSha });
  const io = scriptedIO([]);
  const code = await main(['7', '--list'], { io, cwd: repo.cwd, env: { GITHUB_TOKEN: 't', PATH: process.env.PATH }, fetchImpl: gh.fetchImpl });
  assert.equal(code, 0, io.log.join('\n'));
  assert.ok(io.log.some((l) => /^S1\s+Should fix\s+src\/ingestion\/worker\.js:3/.test(l)), io.log.join('\n'));
  assert.ok(io.log.some((l) => l.includes('missing: skipped (definitely-not-installed-tool is not installed)')));
});

test('init: workflows point at leofmds/peneira by default', async () => {
  const cwd = emptyRepo();
  await main(['init'], { io: scriptedIO([]), cwd, env: {} });
  for (const wf of ['peneira.yml', 'peneira-reviewers.yml', 'peneira-metrics.yml']) {
    assert.match(readFileSync(join(cwd, '.github/workflows', wf), 'utf8'), /uses: leofmds\/peneira@v0/, wf);
  }
  assert.ok(existsSync(join(cwd, '.peneira/config.json')));
});
