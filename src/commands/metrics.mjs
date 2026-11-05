// Review metrics: AI-generated vs other merged PRs, and triage outcomes per reviewer.
import { appendFileSync } from 'node:fs';
import { createGitHub, resolveToken, parseRepoFromRemote } from '../github.mjs';
import { gitSafe } from '../git.mjs';
import { readStore } from '../store.mjs';

export async function runMetrics({ argv = [], cwd, env, io, fetchImpl = globalThis.fetch }) {
  const i = argv.indexOf('--days');
  const days = Number(i >= 0 ? argv[i + 1] : env.DAYS || 14);
  const repo = env.GITHUB_REPOSITORY || parseRepoFromRemote(gitSafe(cwd, 'remote', 'get-url', 'origin'));
  const gh = createGitHub({ token: resolveToken(env), repo, fetchImpl });
  const merged = await gh.listMergedSince(new Date(Date.now() - days * 864e5));

  const rows = [], triage = {};
  for (const p of merged) {
    const [detail, reviews, comments] = await Promise.all([gh.getPr(p.number), gh.listReviews(p.number), gh.listComments(p.number)]);
    const human = reviews.filter((r) => r.user?.type !== 'Bot');
    const first = human.map((r) => Date.parse(r.submitted_at)).sort((a, b) => a - b)[0];
    rows.push({
      ai: p.labels.some((l) => l.name === 'ai-generated'),
      size: detail.additions + detail.deletions,
      firstReview: first ? (first - Date.parse(p.created_at)) / 36e5 : null,
      merge: (Date.parse(p.merged_at) - Date.parse(p.created_at)) / 36e5,
      changeRequests: human.filter((r) => r.state === 'CHANGES_REQUESTED').length,
    });
    for (const decisions of Object.values(readStore(comments).triage)) {
      for (const d of Object.values(decisions)) {
        const t = (triage[d.source] ||= { total: 0 });
        const k = d.decision.startsWith('commented') || d.decision === 'general-note' ? 'posted' : d.decision.startsWith('ticket') ? 'ticket' : d.decision;
        t.total++; t[k] = (t[k] || 0) + 1;
      }
    }
  }

  const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const fmt = (x, d = 1) => (x == null ? 'n/a' : x.toFixed(d));
  const stats = (l) => ({
    n: l.length,
    firstPass: l.length ? (100 * l.filter((r) => !r.changeRequests).length) / l.length : null,
    rounds: l.length ? l.reduce((s, r) => s + r.changeRequests, 0) / l.length : null,
    size: median(l.map((r) => r.size)), firstReview: median(l.map((r) => r.firstReview)), merge: median(l.map((r) => r.merge)),
  });
  const ai = stats(rows.filter((r) => r.ai)), other = stats(rows.filter((r) => !r.ai));
  const pct = (t, k) => (t.total ? `${Math.round((100 * (t[k] || 0)) / t.total)}%` : 'n/a');

  const md = `### Review metrics, last ${days} days (${repo})

| | AI-generated | Other |
|---|---|---|
| PRs merged | ${ai.n} | ${other.n} |
| First-pass merge rate | ${fmt(ai.firstPass, 0)}% | ${fmt(other.firstPass, 0)}% |
| Avg change-request rounds | ${fmt(ai.rounds)} | ${fmt(other.rounds)} |
| Median size (lines) | ${fmt(ai.size, 0)} | ${fmt(other.size, 0)} |
| Median hours to first human review | ${fmt(ai.firstReview)} | ${fmt(other.firstReview)} |
| Median hours to merge | ${fmt(ai.merge)} | ${fmt(other.merge)} |
${Object.keys(triage).length ? `
#### Triage of reviewer findings

| Reviewer | Findings | Posted | Ticket | Ignored | False positive |
|---|---|---|---|---|---|
${Object.entries(triage).map(([s, t]) => `| ${s} | ${t.total} | ${pct(t, 'posted')} | ${pct(t, 'ticket')} | ${pct(t, 'ignored')} | ${pct(t, 'false-positive')} |`).join('\n')}

A high false-positive rate means that reviewer needs tuning; a high ignored rate means it reports things the team does not care about.` : ''}`;

  io.print(md);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`);
  if (env.SLACK_WEBHOOK_URL) await fetchImpl(env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: md }) });
  return 0;
}
