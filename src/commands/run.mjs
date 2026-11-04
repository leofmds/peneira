// `peneira [pr]`: the whole pipeline from inside the repo.
//   resolve PR -> gate (display only) -> reviewers (reuse CI/cache, run the rest in parallel)
//   -> triage finding by finding -> one GitHub review + file comments -> save decisions
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureUserConfig, loadConfig } from '../config.mjs';
import { gitDir, gitSafe } from '../git.mjs';
import { createGitHub, parseRepoFromRemote, resolveToken } from '../github.mjs';
import { ensureCommits, mergeBase, resolvePr } from '../pr.mjs';
import { runPolicy, renderGuide } from '../policy.mjs';
import { plannedReviewers, runReviewer } from '../reviewers/index.mjs';
import { readStore, MARKERS, encodeData } from '../store.mjs';
import { sortFindings, location, GROUP_LABEL } from '../findings.mjs';
import { diffIndex } from '../diffindex.mjs';
import { triageInteractive, parseDecisionSpec, applyDecisionSpec } from '../triage.mjs';
import { buildPublication, publish, MODES } from '../publish.mjs';
import { linearTicketFactory } from '../linear.mjs';

export const RUN_HELP = `Usage: peneira [pr] [options]

  pr                 PR number (14), #14, or URL. Omit to use the open PR of the current branch.

Options:
  --fresh            Ignore CI results and the local cache; run every reviewer locally.
  --only a,b         Run/triage only these reviewers (names from .peneira/config.json).
  --all              Show findings already triaged before.
  --guide            Print the full Review guide (reading order).
  --list             Print the findings and exit (add --json for machine output).
  --decide SPEC      Non-interactive triage, e.g. "P1=c,P2=i,A1=f:unreachable,A3=g".
  --submit MODE      pending (default) | comment | request-changes | none
  --dry-run          Do everything except write to GitHub; print what would be posted.
  --repo owner/name  Override the repo inferred from the origin remote.`;

export function parseRunArgs(argv) {
  const o = { ref: null, only: null, fresh: false, all: false, guide: false, list: false, json: false,
    decide: null, submit: null, dryRun: false, repo: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--fresh') o.fresh = true;
    else if (a === '--all') o.all = true;
    else if (a === '--guide') o.guide = true;
    else if (a === '--list') o.list = true;
    else if (a === '--json') o.json = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--only') o.only = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--decide') o.decide = val();
    else if (a === '--submit') o.submit = val();
    else if (a === '--repo') o.repo = val();
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
    else if (!o.ref) o.ref = a;
    else throw new Error(`Unexpected argument ${a}`);
  }
  if (o.submit && !(o.submit in MODES) && o.submit !== 'none') throw new Error(`--submit must be one of: ${Object.keys(MODES).join(', ')}, none`);
  return o;
}

function cachePath(cwd, pr, name) {
  return join(gitDir(cwd), 'peneira', String(pr.number), pr.headSha, `${name}.json`);
}
function readCache(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; }
}
function writeCache(path, data) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

export async function runReview({ argv = [], cwd = process.cwd(), env = process.env, io, fetchImpl = globalThis.fetch }) {
  const o = parseRunArgs(argv);
  if (o.help) { io.print(RUN_HELP); return 0; }
  const c = io.color;

  ensureUserConfig(env);
  const cfg = loadConfig(cwd, env);
  const repo = o.repo || parseRepoFromRemote(gitSafe(cwd, 'remote', 'get-url', 'origin'));
  if (!repo) throw new Error('Could not infer the GitHub repo from the origin remote; pass --repo owner/name.');
  const gh = createGitHub({ token: resolveToken(env), repo, fetchImpl });

  // 1. PR
  const pr = await resolvePr({ gh, ref: o.ref, cwd });
  io.print(`${c.bold(`PR #${pr.number}`)} ${pr.title}  ${c.dim(`@${pr.author} · head ${pr.headSha.slice(0, 7)}`)}`);
  if (!ensureCommits(cwd, pr)) throw new Error(`Could not get the PR commits locally (git fetch origin pull/${pr.number}/head). Is this the right repo?`);
  const base = mergeBase(cwd, pr), head = pr.headSha;

  // 2. Gate (display only; CI owns labels and the guide comment)
  const report = runPolicy({ cwd, cfg, pr: { ...pr, baseSha: base } });
  const gateIcon = { blocked: c.red('✖'), warnings: c.yellow('●'), passing: c.green('✔') }[report.status];
  io.print(`${gateIcon} Gate: ${report.status} · ${report.logicLines} logic lines / ${report.countedFiles} files` +
    `${report.isAI ? ' · AI-generated' : ''}${report.highRisk ? ` · ${c.yellow('risk: high')}` : ''}`);
  for (const m of report.blocking) io.print(`   ${c.red('✖')} ${m}`);
  for (const m of report.warnings) io.print(`   ${c.yellow('●')} ${m}`);
  if (o.guide) io.print(`\n${renderGuide(report, cfg)}\n`);

  // 3. Reviewers: reuse CI data for this head, then local cache, else run locally (in parallel)
  const comments = await gh.listComments(pr.number);
  const store = readStore(comments);
  const planned = plannedReviewers(cfg, report, o.only);
  if (!planned.length) io.print(c.dim('No reviewers apply to this PR.'));
  const running = planned.filter((r) => o.fresh || !(store.reviewers[r.name]?.headSha === head && store.reviewers[r.name]?.findings)
    && !readCache(cachePath(cwd, pr, r.name)));
  if (running.length) io.print(c.dim(`Running locally: ${running.map((r) => r.name).join(', ')} (this can take a few minutes)...`));

  const results = await Promise.all(planned.map(async (r) => {
    const ci = store.reviewers[r.name];
    if (!o.fresh && ci?.headSha === head && ci.findings) return { ...ci, name: r.name, origin: 'CI' };
    const path = cachePath(cwd, pr, r.name);
    const cached = !o.fresh && readCache(path);
    if (cached) return { ...cached, origin: 'cache' };
    const res = await runReviewer(r, { cwd, base, head, pr, report, cfg, env, fetchImpl });
    if (res.findings) writeCache(path, res);
    return { ...res, origin: 'local' };
  }));
  for (const r of results) {
    if (r.error) io.print(`${c.red('✖')} ${r.name}: failed (${r.error})`);
    else if (r.skipped) io.print(`${c.dim('–')} ${r.name}: skipped (${r.skipped})`);
    else {
      io.print(`${c.green('✔')} ${r.name}: ${r.findings.length} finding(s) ${c.dim(`[${r.origin}]`)}`);
      if (r.suggest && r.origin === 'local') io.print(c.yellow(r.suggest));
    }
  }

  // 4. Queue
  const me = await gh.me();
  const previous = store.triage[me] || {};
  const findings = sortFindings(results.flatMap((r) => r.findings || []));
  const queue = o.all ? findings : findings.filter((f) => !previous[f.fingerprint]);
  if (findings.length !== queue.length) io.print(c.dim(`${findings.length - queue.length} finding(s) triaged earlier (use --all to see them).`));

  if (o.list) {
    if (o.json) io.print(JSON.stringify({ pr: { number: pr.number, title: pr.title, head }, gate: { status: report.status, blocking: report.blocking, warnings: report.warnings }, findings: queue }, null, 2));
    else for (const f of queue) io.print(`${f.id.padEnd(4)} ${GROUP_LABEL[f.group].padEnd(12)} ${location(f)}  ${f.title}`);
    return 0;
  }
  if (!queue.length) { io.print('Nothing new to triage.'); return 0; }

  // 5. Triage
  const index = diffIndex(cwd, base, head);
  let choices;
  if (o.decide) choices = applyDecisionSpec(queue, parseDecisionSpec(o.decide));
  else if (io.interactive) {
    const counts = ['must', 'should', 'nice'].map((g) => `${queue.filter((f) => f.group === g).length} ${g}`).join(', ');
    io.print(`\n${c.bold(`Triage: ${queue.length} finding(s)`)} (${counts})`);
    choices = await triageInteractive({ queue, io, index, createTicket: linearTicketFactory({ env, cfg, prUrl: pr.url, fetchImpl }) });
  } else throw new Error('Not a terminal: use --list to see findings and --decide to triage them.');

  const tally = (d) => choices.filter((x) => x.decision.startsWith(d)).length;
  io.print(`\n${c.bold('Summary')}: ${tally('commented')} comment(s), ${tally('general')} general, ${tally('ticket')} ticket(s), ` +
    `${tally('ignored')} ignored, ${tally('false')} false positive(s).`);

  // 6. Publish
  let mode = o.submit;
  const hasText = choices.some((x) => x.text);
  if (!mode && hasText && !o.decide && io.interactive) {
    const a = (await io.ask(`Post as: ${c.bold('[p]')}ending review (default)  ${c.bold('[c]')}omment  ${c.bold('[r]')}equest changes  ${c.bold('[x]')} don't post\n> `)).toLowerCase();
    mode = { c: 'comment', r: 'request-changes', x: 'none' }[a] || 'pending';
  }
  mode ||= 'pending';

  if (hasText && mode !== 'none') {
    const pub = buildPublication({ choices, index, mode, commitId: head });
    if (pub.movedToBody.length) {
      io.print(c.yellow(`⚠ ${pub.movedToBody.length} finding(s) point at lines outside the diff. In a pending review they go to the review body;` +
        ` submit with comment/request-changes to post them as file comments: ${pub.movedToBody.map((f) => f.id).join(', ')}`));
    }
    if (o.dryRun) io.print(`\n[dry-run] would post:\n${JSON.stringify({ review: pub.review, fileComments: pub.fileComments }, null, 2)}`);
    else {
      try {
        const out = await publish(gh, pr.number, pub);
        io.print(c.green(`✔ ${mode === 'pending' ? 'Pending review saved (submit it in GitHub)' : 'Review submitted'}: ${out.review?.html_url || pr.url}`));
      } catch (e) {
        if (e.status === 422 && /pending/i.test(e.message)) throw new Error('You already have a pending review on this PR. Submit or discard it in GitHub, then run again.');
        throw e;
      }
    }
  }

  // 7. Remember decisions in a sticky comment. Both lines are HTML comments, so the PR shows nothing.
  const decisions = { ...previous };
  for (const ch of choices) {
    const f = ch.finding;
    decisions[f.fingerprint] = { decision: ch.decision, id: f.id, source: f.source, group: f.group, title: f.title,
      ...(ch.reason ? { reason: ch.reason } : {}), ...(ch.ticket ? { ticket: ch.ticket } : {}), at: new Date().toISOString() };
  }
  if (choices.length && !o.dryRun) {
    await gh.upsertSticky(pr.number, MARKERS.triage(me), encodeData({ reviewer: me, decisions }), comments);
  }
  return 0;
}
