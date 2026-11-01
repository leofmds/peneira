// Resolving "which PR?" locally and in CI.
import { existsSync, readFileSync } from 'node:fs';
import { git, gitSafe, hasCommit } from './git.mjs';

/** Accepts 14, "14", "#14", or a PR URL. Returns a number or null. */
export function parsePrRef(ref) {
  if (ref === undefined || ref === null) return null;
  const s = String(ref).trim();
  const m = s.match(/^#?(\d+)$/) || s.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function toPrInfo(pr) {
  return {
    number: pr.number,
    title: pr.title || '',
    body: pr.body || '',
    author: pr.user?.login,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    labels: (pr.labels || []).map((l) => l.name),
    draft: !!pr.draft,
    url: pr.html_url,
  };
}

export async function resolvePr({ gh, ref, cwd }) {
  const n = parsePrRef(ref);
  if (ref && !n) throw new Error(`"${ref}" is not a PR number or URL.`);
  if (n) return toPrInfo(await gh.getPr(n));
  const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const pr = await gh.findOpenPrForBranch(branch);
  if (!pr) throw new Error(`No open PR for branch "${branch}". Pass a number: peneira 14`);
  return toPrInfo(pr);
}

/** Make sure base and head commits exist locally (for diffs, snippets, line checks). */
export function ensureCommits(cwd, pr) {
  if (hasCommit(cwd, pr.headSha) && hasCommit(cwd, pr.baseSha)) return true;
  gitSafe(cwd, 'fetch', '-q', 'origin', pr.baseRef, `pull/${pr.number}/head`);
  return hasCommit(cwd, pr.headSha) && hasCommit(cwd, pr.baseSha);
}

/** The diff GitHub shows is merge-base...head, so compare from the merge base. */
export function mergeBase(cwd, pr) {
  return gitSafe(cwd, 'merge-base', pr.baseSha, pr.headSha)?.trim() || pr.baseSha;
}

export function ciPrFromEvent(env = process.env) {
  const p = env.GITHUB_EVENT_PATH;
  if (!p || !existsSync(p)) throw new Error('Not running in a GitHub pull_request event (GITHUB_EVENT_PATH missing).');
  const ev = JSON.parse(readFileSync(p, 'utf8'));
  if (!ev.pull_request) throw new Error('The GitHub event has no pull_request.');
  return toPrInfo(ev.pull_request);
}
