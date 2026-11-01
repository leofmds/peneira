// `peneira init`: add peneira to the current repo. Never overwrites without --force.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH } from '../config.mjs';
import { REPO_SKILL } from '../reviewers/ponytail.mjs';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '../../templates');
const tpl = (p) => readFileSync(join(TEMPLATES, p), 'utf8');

// Pinned upstream for ponytail-review (MIT). Bump deliberately and review the diff.
export const PONYTAIL = {
  repo: 'DietrichGebert/ponytail',
  commit: '96608e078b2d5ea607c5c3b8b5a54d1c1fba6846',
  version: '5.3.3',
};

export const DEFAULT_ACTION_REF = 'leofmds/peneira@v0';

export const INIT_HELP = `Usage: peneira init [options]

  --preset NAME        default | data-pipeline (default: default)
  --action-ref REF     Action used by the workflows (default: ${DEFAULT_ACTION_REF}; set it for a fork or a pinned SHA)
  --with-ponytail      Vendor the ponytail-review skill (pinned, MIT) into ${REPO_SKILL}
  --force              Overwrite existing files
  --dry-run            Show what would be written`;

export async function runInit({ argv = [], cwd, env, io, fetchImpl = globalThis.fetch }) {
  const o = { preset: 'default', actionRef: null, ponytail: false, force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset') o.preset = argv[++i];
    else if (a === '--action-ref') o.actionRef = argv[++i];
    else if (a === '--with-ponytail') o.ponytail = true;
    else if (a === '--force') o.force = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '-h' || a === '--help') { io.print(INIT_HELP); return 0; }
    else throw new Error(`Unknown option ${a}`);
  }
  if (!existsSync(join(TEMPLATES, `presets/${o.preset}.json`))) throw new Error(`Unknown preset "${o.preset}"`);
  if (!existsSync(join(cwd, '.git'))) throw new Error('Run peneira init at the root of a git repository.');

  const c = io.color;
  const preset = JSON.parse(tpl(`presets/${o.preset}.json`));
  const pyTools = Object.values(preset.reviewers || {}).filter((r) => r.type === 'sarif' && r.requires && r.enabled !== false)
    .map((r) => r.requires).join(' ');
  const actionRef = o.actionRef || DEFAULT_ACTION_REF;
  const wf = (name) => tpl(`github/workflows/${name}`).replaceAll('__ACTION_REF__', actionRef).replaceAll('__PY_TOOLS__', pyTools);

  const claudeMd = tpl('claude/CLAUDE.md').replace('{{PROJECT_RULES}}', tpl(`presets/${o.preset}.rules.md`));
  const files = [
    [CONFIG_PATH, `${JSON.stringify(preset, null, 2)}\n`],
    ['.github/pull_request_template.md', tpl('github/pull_request_template.md')],
    ['.github/CODEOWNERS.example', tpl('github/CODEOWNERS.example')],
    ['docs/spec-template.md', tpl('docs/spec-template.md')],
    ['.claude/commands/pre-pr.md', tpl('claude/commands/pre-pr.md')],
    ['.claude/commands/pr-review.md', tpl('claude/commands/pr-review.md')],
    ['.github/workflows/peneira.yml', wf('peneira.yml')],
    ['.github/workflows/peneira-reviewers.yml', wf('peneira-reviewers.yml')],
    ['.github/workflows/peneira-metrics.yml', wf('peneira-metrics.yml')],
    ['.github/workflows/ci-checks.yml', wf('ci-checks.yml')],
  ];
  // Never clobber an existing CLAUDE.md: offer ours next to it for a manual merge.
  files.push(existsSync(join(cwd, 'CLAUDE.md')) && !o.force ? ['.peneira/CLAUDE.peneira.md', claudeMd] : ['CLAUDE.md', claudeMd]);

  if (o.ponytail) {
    const base = `https://raw.githubusercontent.com/${PONYTAIL.repo}/${PONYTAIL.commit}`;
    const get = async (p) => {
      const res = await fetchImpl(`${base}/${p}`);
      if (!res.ok) throw new Error(`Could not download ${p} from ${PONYTAIL.repo} (${res.status})`);
      return res.text();
    };
    const skillDir = dirname(REPO_SKILL);
    files.push([REPO_SKILL, await get('skills/ponytail-review/SKILL.md')]);
    files.push([`${skillDir}/LICENSE`, await get('LICENSE')]);
    files.push([`${skillDir}/NOTICE.md`, `SKILL.md is vendored unmodified from https://github.com/${PONYTAIL.repo}\n` +
      `(skills/ponytail-review/SKILL.md) at commit ${PONYTAIL.commit} (ponytail ${PONYTAIL.version}).\n` +
      'MIT License, see LICENSE. Update deliberately and review the diff like any other code.\n']);
  }

  const written = [], skipped = [];
  for (const [rel, content] of files) {
    const abs = join(cwd, rel);
    if (existsSync(abs) && !o.force) { skipped.push(rel); continue; }
    if (!o.dryRun) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); }
    written.push(rel);
  }

  io.print(`${o.dryRun ? 'Would write' : 'Wrote'}:`);
  for (const f of written) io.print(`  ${c.green('+')} ${f}`);
  for (const f of skipped) io.print(`  ${c.dim('=')} ${f} ${c.dim('(exists; --force to overwrite)')}`);
  io.print(`\nNext steps:
  1. Review ${CONFIG_PATH} (risk paths, ticket URL, reviewer models).
  2. Add secrets: ANTHROPIC_API_KEY, REVIEW_API_KEY, LINEAR_API_KEY (optional).
  3. Copy .github/CODEOWNERS.example to .github/CODEOWNERS and set the handles.${files.some(([r]) => r.endsWith('CLAUDE.peneira.md')) ? '\n  4. Merge .peneira/CLAUDE.peneira.md into your CLAUDE.md.' : ''}${o.ponytail ? '' : `\n  ${c.yellow('!')} ponytail-review is not vendored: run again with --with-ponytail, or install the ponytail plugin.`}
Then: peneira <PR number>`);
  return 0;
}
