// One finding format shared by every reviewer. Field names follow SARIF where they overlap
// (ruleId-like `title`, level-like `group`, physicalLocation-like file/line/endLine), so
// fromSarif/toSarif are thin mappings.
import { createHash } from 'node:crypto';

export const GROUPS = ['must', 'should', 'nice'];
export const GROUP_LABEL = { must: 'Must fix', should: 'Should fix', nice: 'Nice to have' };
const GROUP_ICON = { must: '🔴', should: '🟠', nice: '🟡' };
const SARIF_LEVEL = { must: 'error', should: 'warning', nice: 'note' };
const FROM_LEVEL = { error: 'must', warning: 'should', note: 'nice', none: 'nice' };

export function makeFinding({ id, source, group, title, file, line, endLine, parts }) {
  const cleanFile = file ? String(file).replace(/^\.?\//, '').replace(/:L?\d+(-L?\d+)?$/, '') : null;
  const ln = Number.isInteger(line) && line > 0 ? line : null;
  const f = {
    id,
    source,
    group: GROUPS.includes(group) ? group : 'should',
    title: String(title || 'Untitled finding').replace(/\s+/g, ' ').trim(),
    file: cleanFile || null,
    line: ln,
    endLine: ln && Number.isInteger(endLine) && endLine > ln ? endLine : null,
    parts: Object.fromEntries(Object.entries(parts || {}).filter(([, v]) => v && String(v).trim())),
  };
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  f.fingerprint = createHash('sha1').update(`${source}|${f.file}|${norm(f.title)}`).digest('hex').slice(0, 12);
  return f;
}

export const location = (f) =>
  f.file ? `${f.file}${f.line ? `:${f.line}${f.endLine ? `-${f.endLine}` : ''}` : ''}` : '(no location)';

export function commentBody(f, { withLocation = false } = {}) {
  const head = `**${f.title}**${withLocation && f.file ? ` (\`${location(f)}\`)` : ''}`;
  const parts = Object.entries(f.parts).map(([k, v]) => `**${k}:** ${v}`).join('\n\n');
  return `${head}\n\n${parts}`.trim();
}

export function sortFindings(list) {
  return [...list].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
}

// ---------- SARIF ----------
export function fromSarif(sarif, { source, prefix }) {
  const out = [];
  for (const run of sarif?.runs || []) {
    const rules = new Map((run.tool?.driver?.rules || []).map((r) => [r.id, r]));
    for (const res of run.results || []) {
      const rule = rules.get(res.ruleId) || {};
      const loc = res.locations?.[0]?.physicalLocation;
      const level = res.level || rule.defaultConfiguration?.level || 'warning';
      const help = rule.help?.text || rule.fullDescription?.text;
      out.push(makeFinding({
        id: `${prefix}${out.length + 1}`,
        source,
        group: FROM_LEVEL[level] || 'should',
        title: rule.shortDescription?.text || res.ruleId || res.message?.text,
        file: loc?.artifactLocation?.uri?.replace(/^file:\/\//, ''),
        line: loc?.region?.startLine,
        endLine: loc?.region?.endLine,
        parts: { Problem: res.message?.text, ...(help ? { Fix: help } : {}), Rule: res.ruleId },
      }));
    }
  }
  return out;
}

export function toSarif(findings, toolName = 'peneira') {
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: { name: toolName, rules: [] } },
      results: findings.map((f) => ({
        ruleId: `${f.source}/${f.fingerprint}`,
        level: SARIF_LEVEL[f.group],
        message: { text: `${f.title}\n\n${Object.entries(f.parts).map(([k, v]) => `${k}: ${v}`).join('\n')}` },
        ...(f.file ? { locations: [{ physicalLocation: {
          artifactLocation: { uri: f.file },
          ...(f.line ? { region: { startLine: f.line, ...(f.endLine ? { endLine: f.endLine } : {}) } } : {}),
        } }] } : {}),
      })),
    }],
  };
}

// ---------- rendering the bot comment ----------
export function renderBotComment({ title, intro, findings, footer, visibility }) {
  const counts = GROUPS.map((g) => `${GROUP_ICON[g]} ${findings.filter((f) => f.group === g).length} ${GROUP_LABEL[g].toLowerCase()}`).join(' · ');
  let details;
  if (!findings.length) details = '_No findings._';
  else if (visibility === 'full') {
    details = GROUPS.map((g) => {
      const list = findings.filter((f) => f.group === g);
      if (!list.length) return null;
      return `**${GROUP_LABEL[g]}**\n\n` + list.map((f) =>
        `${f.id}. **${f.title}** (\`${location(f)}\`)\n` +
        Object.entries(f.parts).map(([k, v]) => `   - **${k}:** ${v}`).join('\n')).join('\n\n');
    }).filter(Boolean).join('\n\n');
  } else {
    details = '_Findings are held for the reviewer to triage. Only the ones the reviewer chooses are posted as review comments._';
  }
  return [`### ${title}`, intro, counts, details, footer].filter(Boolean).join('\n\n');
}
