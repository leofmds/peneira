// Turns triage choices into GitHub objects:
//   - inline comment when the finding's line is in a diff hunk (one thread per finding)
//   - file-level comment when the file is in the PR but the line is not (only when submitting;
//     GitHub cannot hold file-level comments in a pending review, so pending -> review body)
//   - review body for general notes and findings with no location
import { location } from './findings.mjs';

export const MODES = { pending: null, comment: 'COMMENT', 'request-changes': 'REQUEST_CHANGES' };

export function buildPublication({ choices, index, mode, commitId }) {
  const inline = [], fileComments = [], body = [], movedToBody = [];
  for (const ch of choices) {
    if (!ch.text) continue;
    const f = ch.finding;
    const anchor = ch.decision === 'general-note' ? null : index.anchor(f);
    if (anchor) { inline.push({ ...anchor, body: ch.text }); continue; }
    if (ch.decision !== 'general-note' && f.file && index.fileInDiff(f.file)) {
      if (mode !== 'pending') { fileComments.push({ path: f.file, body: ch.text, commitId }); continue; }
      movedToBody.push(f);
    }
    body.push(`- ${ch.text.replace(/^\*\*(.+?)\*\*/, (m) => `${m}${f.file ? ` (\`${location(f)}\`)` : ''}`).replace(/\n\n/g, '\n  ')}`);
  }
  const review = { commit_id: commitId, comments: inline };
  const bodyText = body.length ? `**Review notes**\n\n${body.join('\n')}` : '';
  if (MODES[mode]) {
    review.event = MODES[mode];
    review.body = bodyText || (inline.length ? 'See the inline comments.' : 'See the comments on the files.');
  }
  else if (bodyText) review.body = bodyText;
  const empty = !inline.length && !body.length && !fileComments.length;
  return { review, fileComments, movedToBody, empty };
}

export async function publish(gh, number, pub) {
  const out = { review: null, fileComments: [] };
  if (pub.review.comments.length || pub.review.body || pub.review.event) out.review = await gh.createReview(number, pub.review);
  for (const fc of pub.fileComments) out.fileComments.push(await gh.createFileComment(number, fc));
  return out;
}
