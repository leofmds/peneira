// Which lines of the PR can take an inline comment (GitHub only allows lines inside diff hunks),
// which files are part of the PR, and code snippets for the terminal.
import { gitSafe } from './git.mjs';

export function diffIndex(cwd, base, head) {
  const files = new Map(); // path -> Map(line -> hunkNo)
  const diff = gitSafe(cwd, 'diff', '-U3', base, head) || '';
  let file = null, line = 0, hunk = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git')) { file = null; continue; }
    if (l.startsWith('+++ ')) {
      file = l.startsWith('+++ b/') ? l.slice(6) : null;
      if (file && !files.has(file)) files.set(file, new Map());
      continue;
    }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { line = Number(h[1]); hunk++; continue; }
    if (!file || l.startsWith('--- ') || l.startsWith('\\') || l.startsWith('-')) continue;
    files.get(file).set(line++, hunk);
  }
  const deleted = new Set((gitSafe(cwd, 'diff', '--name-only', '--diff-filter=D', base, head) || '').split('\n').filter(Boolean));

  return {
    fileInDiff: (path) => !!path && (files.has(path) || deleted.has(path)),
    anchor(f) {
      const lines = f.file && f.line ? files.get(f.file) : null;
      if (!lines?.has(f.line)) return null;
      if (f.endLine && lines.get(f.endLine) === lines.get(f.line)) {
        return { path: f.file, start_line: f.line, start_side: 'RIGHT', line: f.endLine, side: 'RIGHT' };
      }
      return { path: f.file, line: f.line, side: 'RIGHT' };
    },
    snippet(f, c) {
      if (!f.file || !f.line) return '';
      const src = gitSafe(cwd, 'show', `${head}:${f.file}`);
      if (!src) return '';
      const lines = src.split('\n');
      const from = Math.max(1, f.line - 2), to = Math.min(lines.length, (f.endLine || f.line) + 2);
      const out = [];
      for (let n = from; n <= to; n++) {
        const hit = n >= f.line && n <= (f.endLine || f.line);
        out.push(`${hit ? c.cyan('▶') : ' '} ${c.dim(String(n).padStart(4))} ${lines[n - 1]}`);
      }
      return out.join('\n');
    },
  };
}
