// Reviewer registry. A reviewer is { available(ctx) -> {ok, reason}, run(ctx) -> result }.
// result: { title, intro?, findings: Finding[], meta? }. Adding a reviewer = adding a type here
// or configuring a `sarif` reviewer with a command; the core never changes.
import { appliesTo } from '../config.mjs';
import * as ponytail from './ponytail.mjs';
import * as llm from './llm.mjs';
import * as sarif from './sarif.mjs';

export const TYPES = { ponytail, llm, sarif };

export function plannedReviewers(cfg, report, only = null) {
  return Object.entries(cfg.reviewers || {})
    .filter(([name, conf]) => conf && conf.enabled !== false && (!only || only.includes(name)))
    .map(([name, conf]) => ({
      name, conf, adapter: TYPES[conf.type || name],
      applies: !!only || appliesTo(conf.runFor || 'all', report),
    }))
    .filter((r) => r.adapter && r.applies);
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
