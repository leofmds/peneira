// The policy gate: size budget, linked ticket, description sections, dependencies,
// risk signals and reading order. Pure over (repo, config, PR info): no API calls.
import { git, gitSafe } from './git.mjs';
import { matcher, escapeRe } from './util.mjs';
import { appliesTo } from './config.mjs';

function numstat(cwd, base, head, extra = []) {
  const raw = git(cwd, 'diff', '--numstat', '-z', '-M', ...extra, base, head);
  const parts = raw.split('\0');
  const files = new Map();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const [a, d, path] = p.split('\t');
    let from = null, to = path;
    if (path === '') { from = parts[++i]; to = parts[++i]; } // rename: paths follow in two NUL fields
    files.set(to, { path: to, from, added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d), binary: a === '-' });
  }
  return files;
}

export function section(body, name) {
  const lines = String(body || '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const head = new RegExp(`^#{2,4}\\s*${escapeRe(name)}\\s*$`, 'i');
  const start = lines.findIndex((l) => head.test(l.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,4}\s/.test(l.trim()));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

/**
 * @param {{cwd:string, cfg:any, pr:{baseSha,headSha,title,body,headRef,labels,draft?}}} args
 * baseSha should be the merge base, so the diff matches what GitHub shows.
 */
export function runPolicy({ cwd, cfg, pr }) {
  const base = pr.baseSha, head = pr.headSha;
  const files = numstat(cwd, base, head);
  const semantic = numstat(cwd, base, head, ['-w', '--ignore-blank-lines']);

  const isIgnored = matcher(cfg.ignore);
  const isFoundation = matcher(cfg.categories.foundation);
  const isTest = matcher(cfg.categories.tests);
  const isRiskPath = matcher(cfg.risk.paths);

  for (const f of files.values()) {
    const s = semantic.get(f.path);
    const semanticLines = s ? s.added + s.deleted : 0;
    if (isIgnored(f.path)) f.category = 'ignored';
    else if (!f.binary && semanticLines === 0) f.category = 'mechanical';
    else if (isTest(f.path)) f.category = 'tests';
    else if (isFoundation(f.path)) f.category = 'foundation';
    else f.category = 'behavior';
    f.logicLines = ['behavior', 'foundation'].includes(f.category) ? semanticLines : 0;
    f.risky = isRiskPath(f.path);
  }
  const all = [...files.values()];

  // AI detection
  const trailerRe = new RegExp(cfg.aiDetection.commitTrailerPattern, 'i');
  const msgs = gitSafe(cwd, 'log', '--format=%B%x00', `${base}..${head}`) || '';
  const aiSignals = [];
  if ((pr.labels || []).some((l) => cfg.aiDetection.labels.includes(l))) aiSignals.push('label');
  if (cfg.aiDetection.branchPrefixes.some((p) => (pr.headRef || '').startsWith(p))) aiSignals.push('branch prefix');
  if (msgs.split('\0').some((m) => trailerRe.test(m))) aiSignals.push('commit trailer');
  const isAI = aiSignals.length > 0;

  const blocking = [], warnings = [];
  const fail = (scope, msg) => (appliesTo(scope, { isAI }) && !pr.draft ? blocking : warnings).push(msg);

  // Size budget
  const logicLines = all.reduce((n, f) => n + f.logicLines, 0);
  const countedFiles = all.filter((f) => !['ignored', 'mechanical'].includes(f.category)).length;
  const overBudget = logicLines > cfg.budget.maxLogicLines || countedFiles > cfg.budget.maxFiles;
  if (overBudget) {
    fail(cfg.budget.blockingFor, `Size budget exceeded: ${logicLines} logic lines / ${countedFiles} files ` +
      `(budget ${cfg.budget.maxLogicLines} / ${cfg.budget.maxFiles}). Split into stacked PRs.`);
  }

  // Ticket
  const ticketRe = new RegExp(cfg.ticket.pattern, 'i');
  const tm = [pr.title, (pr.headRef || '').replace(/[/_]/g, ' '), pr.body].map((s) => String(s || '').match(ticketRe)).find(Boolean);
  const ticket = tm ? tm[1].toUpperCase() : null;
  if (!ticket) fail(cfg.ticket.requiredFor, 'No linked ticket found in title, branch or description.');

  // Description sections
  const missing = cfg.templateSections.sections.filter((s) => !section(pr.body, s));
  if (missing.length) fail(cfg.templateSections.requiredFor, `PR description is missing or has empty sections: ${missing.join(', ')}.`);

  // Dependencies
  const depChanges = [];
  for (const f of all.filter((x) => x.path.endsWith('package.json') && !isIgnored(x.path))) {
    const parse = (rev, p) => { try { return JSON.parse(git(cwd, 'show', `${rev}:${p}`)); } catch { return {}; } };
    const before = parse(base, f.from || f.path), after = parse(head, f.path);
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const b = before[key] || {}, a = after[key] || {};
      for (const [name, ver] of Object.entries(a)) {
        if (!(name in b)) depChanges.push({ file: f.path, kind: 'added', name, version: ver, scope: key });
        else if (b[name] !== ver) depChanges.push({ file: f.path, kind: 'changed', name, from: b[name], version: ver, scope: key });
      }
    }
  }
  const addedDeps = depChanges.filter((d) => d.kind === 'added');
  if (addedDeps.length && !section(pr.body, 'Dependency justification')) {
    fail('ai', `New dependencies without a "Dependency justification" section: ${addedDeps.map((d) => d.name).join(', ')}.`);
  }

  // Risk signals on added lines
  const riskRes = cfg.risk.addedLinePatterns.map((p) => new RegExp(p, 'i'));
  const riskHits = [];
  let current = null;
  for (const line of git(cwd, 'diff', '-U0', base, head).split('\n')) {
    if (line.startsWith('+++ ')) { current = line.startsWith('+++ b/') ? line.slice(6) : null; continue; }
    if (!current || isIgnored(current) || !line.startsWith('+')) continue;
    const hit = riskRes.find((r) => r.test(line));
    if (hit) riskHits.push({ file: current, pattern: hit.source, line: line.slice(1).trim().slice(0, 140) });
  }
  const riskyFiles = all.filter((f) => f.risky && f.category !== 'ignored').map((f) => f.path);
  const highRisk = riskyFiles.length > 0 || riskHits.length > 0 || addedDeps.length > 0;

  // Reading order
  const order = ['foundation', 'behavior', 'tests', 'mechanical', 'ignored'];
  const migrationFirst = (p) => (/migrations?\//.test(p) || p.endsWith('.sql') ? 0 : 1);
  const readingOrder = all.sort((a, b) =>
    order.indexOf(a.category) - order.indexOf(b.category) ||
    migrationFirst(a.path) - migrationFirst(b.path) ||
    Number(b.risky) - Number(a.risky) ||
    a.path.localeCompare(b.path))
    .map(({ path, from, category, risky, added, deleted }) => ({ path, from, category, risky, added, deleted }));

  const labels = [];
  if (isAI) labels.push('ai-generated');
  if (highRisk) labels.push('risk:high');
  if (overBudget) labels.push('needs-split');

  return {
    ticket, isAI, aiSignals, highRisk, overBudget, logicLines, countedFiles,
    blocking, warnings, depChanges, riskHits, riskyFiles, readingOrder, labels,
    status: blocking.length ? 'blocked' : warnings.length ? 'warnings' : 'passing',
  };
}

export function renderGuide(report, cfg) {
  const titles = {
    foundation: '1. Foundations (schemas, migrations, types, config)',
    behavior: '2. Behavior (the actual logic)',
    tests: '3. Tests (do they prove the spec, or just pass?)',
    mechanical: '4. Mechanical only (renames / whitespace), skim',
    ignored: '5. Generated / lockfiles, not counted',
  };
  const status = { blocked: '🔴 Blocked', warnings: '🟡 Passing with warnings', passing: '🟢 Passing' }[report.status];
  const ticket = !report.ticket ? '_none found_'
    : cfg.ticket.urlTemplate ? `[${report.ticket}](${cfg.ticket.urlTemplate.replace('{id}', report.ticket)})` : report.ticket;
  const block = (t, items) => (items.length ? `**${t}**\n${items.join('\n')}\n\n` : '');
  const grouped = Object.keys(titles).map((cat) => {
    const list = report.readingOrder.filter((f) => f.category === cat);
    return list.length ? `**${titles[cat]}**\n${list.map((f) =>
      `- [ ] \`${f.path}\`${f.from ? ` (renamed from \`${f.from}\`)` : ''} +${f.added}/-${f.deleted}${f.risky ? ' ⚠️' : ''}`).join('\n')}` : null;
  }).filter(Boolean).join('\n\n');

  return `### Review guide: ${status}

| | |
|---|---|
| Ticket | ${ticket} |
| AI-generated | ${report.isAI ? `yes (${report.aiSignals.join(', ')})` : 'no signals'} |
| Logic size | ${report.logicLines} lines / ${report.countedFiles} files (budget ${cfg.budget.maxLogicLines} / ${cfg.budget.maxFiles}) |
| Risk | ${report.highRisk ? '**high**: deep-review the ⚠️ items' : 'normal'} |

${block('Blocking', report.blocking.map((m) => `- ❌ ${m}`))}${block('Warnings', report.warnings.map((m) => `- ⚠️ ${m}`))}${block('Dependency changes (review these first)', report.depChanges.map((d) =>
    `- ${d.kind === 'added' ? '🆕' : '↕️'} \`${d.name}\` ${d.from ? `${d.from} → ` : ''}${d.version} (${d.scope}, \`${d.file}\`)`))}${block('Risk signals in added lines', report.riskHits.slice(0, 15).map((h) =>
    `- \`${h.file}\`: \`${h.line.replace(/`/g, "'")}\``))}#### Suggested reading order
${grouped || '_No files changed._'}`;
}
