import { execFileSync } from 'node:child_process';

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
export function gitSafe(cwd, ...args) {
  try { return git(cwd, ...args); } catch { return null; }
}
export const gitDir = (cwd) => git(cwd, 'rev-parse', '--absolute-git-dir').trim();
export const hasCommit = (cwd, sha) => gitSafe(cwd, 'cat-file', '-e', `${sha}^{commit}`) !== null;
