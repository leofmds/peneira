// Reviewer registry. A reviewer is { available(ctx) -> {ok, reason}, run(ctx) -> result }.
// result: { title, intro?, findings: Finding[], meta? }. Adding a reviewer = adding a type here
// or configuring a `sarif` reviewer with a command; the core never changes.
import { appliesTo } from '../config.mjs';
import * as ponytail from './ponytail.mjs';
import * as llm from './llm.mjs';
import * as sarif from './sarif.mjs';

export const TYPES = { ponytail, llm, sarif };

const DEFAULT_PREFIX = { llm: 'A', ponytail: 'P', sarif: 'S' };

export function plannedReviewers(cfg, report, only = null) {
  const planned = Object.entries(cfg.reviewers || {})
    .filter(([name, conf]) => conf && conf.enabled !== false && (!only || only.includes(name)))
    .map(([name, conf]) => ({
      name, conf, adapter: TYPES[conf.type || name],
      applies: !!only || appliesTo(conf.runFor || 'all', report),
    }))
    .filter((r) => r.adapter && r.applies);
  // Finding ids are prefix + number. When a prefix is taken, the later reviewer uses its own name
  // ("quality" -> QUALITY1), so two reviewers of one type never both have an "A1".
  const seen = new Set();
  return planned.map((r) => {
    let prefix = r.conf.prefix || DEFAULT_PREFIX[r.conf.type || r.name];
    if (seen.has(prefix)) prefix = r.name.toUpperCase().replace(/[^A-Z]/g, '') || `${prefix}X`;
    seen.add(prefix);
    return { ...r, conf: { ...r.conf, prefix } };
  });
}

/** Runs one reviewer; never throws: failures come back as { error }. */
export async function runReviewer(r, ctx) {
  const avail = r.adapter.available({ ...ctx, conf: r.conf });
  if (!avail.ok) return { name: r.name, skipped: avail.reason };
  try {
    const result = await r.adapter.run({ ...ctx, name: r.name, conf: r.conf });
    return { name: r.name, ...result, baseSha: ctx.base, headSha: ctx.head };
  } catch (e) {
    return { name: r.name, error: e.message };
  }
}
