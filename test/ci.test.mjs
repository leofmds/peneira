import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { readStore } from '../src/store.mjs';
import { fixtureRepo, fakeGitHub, fakeClaude, withSkill, scriptedIO, PONYTAIL_FINDINGS } from './helpers.mjs';

function ciEnv(gh, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rg-ci-'));
  const event = join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: gh.pr }));
  return { GITHUB_EVENT_PATH: event, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
    GITHUB_OUTPUT: join(dir, 'out'), GITHUB_STEP_SUMMARY: join(dir, 'summary'), PATH: process.env.PATH, ...extra, _dir: dir };
}

test('ci policy: labels, guide comment, outputs, fails on blocking rules', async () => {
  const repo = fixtureRepo();
  const gh = fakeGitHub({ baseSha: repo.baseSha, headSha: repo.headSha, body: '' });
  const env = ciEnv(gh);
  const io = scriptedIO([]);
  const code = await main(['ci', 'policy'], { io, env, cwd: repo.cwd, fetchImpl: gh.fetchImpl });
  assert.equal(code, 1, 'AI PR with empty description is blocked');
  assert.deepEqual(gh.state.labels, ['ai-generated', 'risk:high']);
  assert.ok(gh.state.comments.some((c) => c.body.startsWith('<!-- peneira:guide -->') && c.body.includes('Suggested reading order')));
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /is_ai=true\nhigh_risk=true/);
  assert.ok(io.log.some((l) => l.startsWith('::error::')));
});

test('ci reviewers -> local `peneira` reuses the CI findings without running anything', async () => {
  const repo = fixtureRepo({ config: { reviewers: { llm: { enabled: false } } } });
  withSkill(repo.cwd);
  const counter = join(mkdtempSync(join(tmpdir(), 'rg-c-')), 'calls');
  const gh = fakeGitHub({ baseSha: repo.baseSha, headSha: repo.headSha });
  const claude = fakeClaude(PONYTAIL_FINDINGS, { counterFile: counter });

  const code = await main(['ci', 'reviewers'], { io: scriptedIO([]), env: ciEnv(gh, { CLAUDE_BIN: claude }), cwd: repo.cwd, fetchImpl: gh.fetchImpl });
  assert.equal(code, 0);
  const sticky = gh.state.comments.find((c) => c.body.startsWith('<!-- peneira:reviewer:ponytail -->'));
  assert.ok(sticky);
  assert.doesNotMatch(sticky.body.split('<!-- peneira:data')[0], /Retries insert duplicates/, 'summary visibility hides findings from the author');
  assert.match(sticky.body, /1 must fix · 🟠 1 should fix · 🟡 2 nice/);
  assert.equal(readStore(gh.state.comments).reviewers.ponytail.findings.length, 4);
  assert.equal(readFileSync(counter, 'utf8').length, 1);

  const io = scriptedIO([]);
  await main(['7', '--decide', 'P1=c', '--submit', 'comment'], { io, env: { GITHUB_TOKEN: 't', CLAUDE_BIN: claude, PATH: process.env.PATH }, cwd: repo.cwd, fetchImpl: gh.fetchImpl });
  assert.equal(readFileSync(counter, 'utf8').length, 1, 'no local re-run');
  assert.ok(io.log.some((l) => l.includes('[CI]')));
  assert.equal(gh.state.reviews[0].comments.length, 1);
  assert.equal(gh.state.reviews[0].event, 'COMMENT');
});

test('ci reviewers: a failing reviewer is reported, not fatal', async () => {
  const repo = fixtureRepo({ config: { reviewers: { llm: { enabled: false } } } });
  withSkill(repo.cwd);
  const gh = fakeGitHub({ baseSha: repo.baseSha, headSha: repo.headSha });
  const io = scriptedIO([]);
  const bin = join(mkdtempSync(join(tmpdir(), 'rg-fail-')), 'claude');
  writeFileSync(bin, '#!/bin/sh\nexit 1\n');
  chmodSync(bin, 0o755);
  const code = await main(['ci', 'reviewers'], { io, env: ciEnv(gh, { CLAUDE_BIN: bin }), cwd: repo.cwd, fetchImpl: gh.fetchImpl });
  assert.equal(code, 0);
  assert.ok(io.log.some((l) => l.startsWith('::warning::ponytail failed')));
  assert.ok(gh.state.comments.some((c) => c.body.includes('Review failed to run')));
});
