// GitHub platform client. The only module that talks to the GitHub API, so another
// platform (GitLab, Bitbucket) can be added later behind the same methods.
import { execFileSync } from 'node:child_process';

export function resolveToken(env = process.env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

export function parseRepoFromRemote(url) {
  const m = String(url || '').trim().match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

export function createGitHub({ token, repo, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('No GitHub token: set GITHUB_TOKEN or run `gh auth login`.');

  async function request(method, path, body) {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === 'DELETE') return null;
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 500)}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  async function paginate(path) {
    const out = [];
    for (let page = 1; page < 50; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = await request('GET', `${path}${sep}per_page=100&page=${page}`);
      if (!Array.isArray(batch) || !batch.length) break;
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  const r = `/repos/${repo}`;
  return {
    repo,
    request,
    paginate,
    me: async () => (await request('GET', '/user')).login,
    getPr: (n) => request('GET', `${r}/pulls/${n}`),
    async findOpenPrForBranch(branch) {
      const owner = repo.split('/')[0];
      const list = await request('GET', `${r}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      return list?.[0] || null;
    },
    listComments: (n) => paginate(`${r}/issues/${n}/comments`),
    async upsertSticky(n, marker, body, comments) {
      const full = `${marker}\n${body}`;
      const list = comments || await paginate(`${r}/issues/${n}/comments`);
      const existing = list.find((c) => c.body?.startsWith(marker));
      if (existing) return request('PATCH', `${r}/issues/comments/${existing.id}`, { body: full });
      return request('POST', `${r}/issues/${n}/comments`, { body: full });
    },
    deleteComment: (id) => request('DELETE', `${r}/issues/comments/${id}`),
    async syncLabels(n, current, wanted, managed) {
      const add = wanted.filter((l) => !current.includes(l));
      const remove = managed.filter((l) => current.includes(l) && !wanted.includes(l));
      if (add.length) await request('POST', `${r}/issues/${n}/labels`, { labels: add });
      for (const l of remove) await request('DELETE', `${r}/issues/${n}/labels/${encodeURIComponent(l)}`);
    },
    createReview: (n, review) => request('POST', `${r}/pulls/${n}/reviews`, review),
    createFileComment: (n, { path, body, commitId }) =>
      request('POST', `${r}/pulls/${n}/comments`, { path, body, commit_id: commitId, subject_type: 'file' }),
    listMergedSince: async (since) => {
      const out = [];
      for (let page = 1; page < 20; page++) {
        const batch = await request('GET', `${r}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
        if (!batch?.length) break;
        out.push(...batch);
        if (new Date(batch.at(-1).updated_at) < since) break;
      }
      return out.filter((p) => p.merged_at && new Date(p.merged_at) >= since);
    },
    listReviews: (n) => paginate(`${r}/pulls/${n}/reviews`),
  };
}
