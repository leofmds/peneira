import { readFileSync } from 'node:fs';
import { terminalIO } from './ui.mjs';
import { runReview, RUN_HELP } from './commands/run.mjs';

const HELP = `peneira: gate, review and triage pull requests. You decide what gets posted.

  peneira [pr] [options]       Run the whole pipeline for a PR (default command)
  peneira init [options]       Add peneira to this repo (config, templates, workflows)
  peneira ci <step>            CI steps: policy | reviewers | metrics
  peneira metrics [--days N]   Review metrics for the repo
  peneira --version

  \`review\` is installed as an alias of \`peneira\`.

${RUN_HELP}`;

export async function main(argv, { io = terminalIO(), env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch } = {}) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === '--version' || cmd === '-v') {
      io.print(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
      return 0;
    }
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') { io.print(HELP); return 0; }
    if (cmd === 'init') return (await import('./commands/init.mjs')).runInit({ argv: rest, cwd, env, io, fetchImpl });
    if (cmd === 'ci') return (await import('./commands/ci.mjs')).runCi({ argv: rest, cwd, env, io, fetchImpl });
    if (cmd === 'metrics') return (await import('./commands/metrics.mjs')).runMetrics({ argv: rest, cwd, env, io, fetchImpl });
    if (cmd === 'run') return await runReview({ argv: rest, cwd, env, io, fetchImpl });
    return await runReview({ argv, cwd, env, io, fetchImpl });
  } catch (e) {
    io.print(io.color.red(`✖ ${e.message}`));
    if (env.PENEIRA_DEBUG) io.print(e.stack);
    return 1;
  }
}
