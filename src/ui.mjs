// Terminal I/O. Everything interactive goes through an `io` object so tests can script it.
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

export function colors(enabled) {
  const c = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: c(1), dim: c(2), red: c(31), green: c(32), yellow: c(33), cyan: c(36) };
}

export function terminalIO({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  return {
    color: colors(stdout.isTTY && !env.NO_COLOR),
    interactive: !!stdin.isTTY,
    print: (s = '') => { stdout.write(`${s}\n`); },
    async ask(q) {
      const rl = createInterface({ input: stdin, output: stdout });
      try { return (await rl.question(q)).trim(); } finally { rl.close(); }
    },
    edit(initial) {
      const dir = mkdtempSync(join(tmpdir(), 'peneira-'));
      const file = join(dir, 'comment.md');
      writeFileSync(file, initial);
      spawnSync(env.VISUAL || env.EDITOR || 'vi', [file], { stdio: 'inherit', shell: true });
      const text = readFileSync(file, 'utf8').trim();
      rmSync(dir, { recursive: true, force: true });
      return text;
    },
  };
}

/** Scripted IO for tests and for piping answers in. */
export function scriptedIO(answers, { log = [] } = {}) {
  const queue = [...answers];
  return {
    color: colors(false),
    interactive: false,
    log,
    print: (s = '') => { log.push(String(s)); },
    async ask(q) { const a = queue.length ? queue.shift() : 'q'; log.push(`${q}${a}`); return String(a).trim(); },
    edit: (initial) => (queue.length && String(queue[0]).startsWith('EDIT:') ? queue.shift().slice(5) : initial),
  };
}
