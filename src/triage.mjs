// Finding-by-finding triage. Interactive (prompts) or non-interactive (a decision spec).
import { GROUP_LABEL, commentBody, location } from './findings.mjs';

export const ACTION_KEYS = { c: 'commented', e: 'commented-edited', g: 'general-note', i: 'ignored', f: 'false-positive', t: 'ticket' };

/**
 * @returns {Promise<Array<{finding, decision, text?, reason?, ticket?}>>}
 */
export async function triageInteractive({ queue, io, index, createTicket }) {
  const c = io.color;
  const tint = { must: c.red, should: c.yellow, nice: c.dim };
  const chosen = new Map();
  const keys = `${c.bold('[c]')}omment  ${c.bold('[e]')}dit+comment  ${c.bold('[g]')}eneral note  ${c.bold('[i]')}gnore  ` +
    `${c.bold('[f]')}alse positive${createTicket ? `  ${c.bold('[t]')}icket` : ''}  ${c.bold('[b]')}ack  ${c.bold('[q]')}uit`;

  for (let i = 0; i < queue.length;) {
    const f = queue[i];
    const anchored = index.anchor(f);
    const where = !f.file ? 'review body' : anchored ? 'inline' : index.fileInDiff(f.file) ? 'file comment' : 'review body';
    io.print(`\n${c.dim('─'.repeat(72))}`);
    io.print(`${c.bold(`[${i + 1}/${queue.length}]`)} ${tint[f.group](GROUP_LABEL[f.group].toUpperCase())}  ${c.dim(`${f.source} ${f.id}`)}  ${location(f)}  ${c.dim(`→ ${where}`)}`);
    io.print(c.bold(f.title));
    for (const [k, v] of Object.entries(f.parts)) io.print(`  ${c.cyan(k)}: ${v}`);
    const snip = index.snippet(f, c);
    if (snip) io.print(`\n${snip}`);
    if (chosen.has(i)) io.print(c.dim(`  (current choice: ${chosen.get(i).decision})`));

    const key = (await io.ask(`\n${keys}\n> `)).toLowerCase();
    try {
      if (key === 'c' || key === 'g') {
        chosen.set(i, { finding: f, decision: ACTION_KEYS[key], text: commentBody(f) });
      } else if (key === 'e') {
        const text = io.edit(commentBody(f));
        if (!text) { io.print(c.yellow('Empty comment, nothing chosen.')); continue; }
        chosen.set(i, { finding: f, decision: 'commented-edited', text });
      } else if (key === 'i') {
        chosen.set(i, { finding: f, decision: 'ignored' });
      } else if (key === 'f') {
        const reason = await io.ask('Why is it a false positive? (optional, helps tune the reviewer) ');
        chosen.set(i, { finding: f, decision: 'false-positive', ...(reason ? { reason } : {}) });
      } else if (key === 't' && createTicket) {
        const issue = await createTicket(f);
        io.print(c.green(`Created ${issue.identifier} ${issue.url}`));
        const also = (await io.ask('Also leave a comment on the PR pointing to it? [y/N] ')).toLowerCase() === 'y';
        chosen.set(i, also
          ? { finding: f, decision: 'ticket+comment', ticket: issue.identifier,
              text: `${commentBody(f)}\n\n_Follow-up tracked in [${issue.identifier}](${issue.url}); not blocking this PR._` }
          : { finding: f, decision: 'ticket', ticket: issue.identifier });
      } else if (key === 'b') { i = Math.max(0, i - 1); continue; }
      else if (key === 'q') break;
      else { io.print(c.yellow('Unknown choice.')); continue; }
    } catch (e) { io.print(c.red(`Failed: ${e.message}`)); continue; }
    i++;
  }
  return [...chosen.values()];
}

/**
 * Non-interactive: "P1=c,P2=i,A1=f:not reachable,A2=g". Unlisted findings stay untriaged.
 * Supported: c (comment), g (general note), i (ignore), f[:reason] (false positive).
 */
export function parseDecisionSpec(spec) {
  const out = new Map();
  for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z]+\d+)=([cgif])(?::(.*))?$/);
    if (!m) throw new Error(`Bad decision "${part}". Use ID=c|g|i|f[:reason], e.g. P1=c,A2=f:unreachable`);
    out.set(m[1].toUpperCase(), { key: m[2], reason: m[3]?.trim() });
  }
  return out;
}

export function applyDecisionSpec(queue, specMap) {
  const unknown = [...specMap.keys()].filter((id) => !queue.some((f) => f.id.toUpperCase() === id));
  if (unknown.length) throw new Error(`Unknown finding id(s): ${unknown.join(', ')}`);
  return queue.filter((f) => specMap.has(f.id.toUpperCase())).map((f) => {
    const { key, reason } = specMap.get(f.id.toUpperCase());
    const decision = ACTION_KEYS[key];
    return { finding: f, decision, ...(key === 'c' || key === 'g' ? { text: commentBody(f) } : {}), ...(reason ? { reason } : {}) };
  });
}
