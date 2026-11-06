// `peneira ci <step>`: the same engine, driven by a GitHub pull_request event.
//   policy     labels + Review guide comment; fails the job on blocking rules
//   reviewers  runs applicable reviewers; stores findings (hidden) in one sticky comment each
//   metrics    see metrics.mjs
import { appendFileSync } from 'node:fs';
import { loadConfig } from '../config.mjs';
import { createGitHub } from '../github.mjs';
import { ciPrFromEvent, mergeBase } from '../pr.mjs';
import { runPolicy, renderGuide } from '../policy.mjs';
import { plannedReviewers, runReviewer } from '../reviewers/index.mjs';
import { MARKERS, withData } from '../store.mjs';
import { renderBotComment } from '../findings.mjs';

const summary = (env, md) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`);
const output = (env, k, v) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);

export async function runCi({ argv, cwd, env, io, fetchImpl = globalThis.fetch }) {
  const [step, ...rest] = argv;
  if (step === 'metrics') return (await import('./metrics.mjs')).runMetrics({ argv: rest, cwd, env, io, fetchImpl });
  if (!['policy', 'reviewers'].includes(step)) throw new Error('Usage: peneira ci policy | reviewers [--only a,b] [--compare] | metrics');

  const cfg = loadConfig(cwd);
  const pr = ciPrFromEvent(env);
  const gh = createGitHub({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, fetchImpl });
  const base = mergeBase(cwd, pr), head = pr.headSha;
  const report = runPolicy({ cwd, cfg, pr: { ...pr, baseSha: base } });

  if (step === 'policy') {
    const guide = renderGuide(report, cfg);
    await gh.syncLabels(pr.number, pr.labels, report.labels, ['risk:high', 'needs-split']);
    await gh.upsertSticky(pr.number, MARKERS.guide, guide);
    summary(env, guide);
    output(env, 'is_ai', report.isAI);
    output(env, 'high_risk', report.highRisk);
    io.print(`gate: ${report.status} (AI=${report.isAI}, risk=${report.highRisk}, ${report.logicLines} lines / ${report.countedFiles} files)`);
    for (const m of report.blocking) io.print(`::error::${m}`);
    return report.blocking.length ? 1 : 0;
  }

  // reviewers
  const i = rest.indexOf('--only');
  const only = i >= 0 ? rest[i + 1].split(',') : null;
  const planned = plannedReviewers(cfg, report, only, rest.includes('--compare'));
  const visibility = cfg.findings?.visibility || 'summary';
  const comments = await gh.listComments(pr.number);
  const results = await Promise.all(planned.map((r) => runReviewer(r, { cwd, base, head, pr, report, cfg, env, fetchImpl })));

  for (const res of results) {
    const marker = MARKERS.reviewer(res.name);
    if (res.skipped) { io.print(`${res.name}: skipped (${res.skipped})`); continue; }
    if (res.error) {
      io.print(`::warning::${res.name} failed: ${res.error}`);
      await gh.upsertSticky(pr.number, marker, withData(`### ${res.name}\n\n_Review failed to run: ${res.error.slice(0, 300)}_`,
        { headSha: head, error: res.error }), comments);
      continue;
    }
    const footer = '<sub>Run `peneira ' + pr.number + '` in the repo to decide, finding by finding, what gets posted.</sub>';
    const md = renderBotComment({ title: res.title || res.name, intro: res.intro, findings: res.findings, footer, visibility });
    await gh.upsertSticky(pr.number, marker, withData(md, {
      headSha: head, baseSha: base, title: res.title, intro: res.intro, findings: res.findings, meta: res.meta, skill: res.skill,
    }), comments);
    summary(env, renderBotComment({ title: res.title || res.name, intro: res.intro, findings: res.findings, visibility: 'full' }));
    io.print(`${res.skill ? `${res.name} (${res.skill})` : res.name}: ${res.findings.length} finding(s)`);
  }
  return 0; // reviewers are advisory
}
