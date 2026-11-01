// Everything peneira keeps on a PR lives in sticky comments with a marker and a hidden
// base64 data block. This module is the only place that knows the markers.
const DATA_RE = /<!-- peneira:data ([A-Za-z0-9+/=]+) -->/;

export const MARKERS = {
  guide: '<!-- peneira:guide -->',
  reviewer: (name) => `<!-- peneira:reviewer:${name} -->`,
  triage: (login) => `<!-- peneira:triage:${login} -->`,
};

export function encodeData(obj) {
  return `<!-- peneira:data ${Buffer.from(JSON.stringify(obj)).toString('base64')} -->`;
}
export function decodeData(body) {
  const m = String(body || '').match(DATA_RE);
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); } catch { return null; }
}

/** Parse all peneira state out of a PR's issue comments. */
export function readStore(comments) {
  const store = { reviewers: {}, triage: {} };
  for (const c of comments || []) {
    const body = c.body || '';
    let m = body.match(/^<!-- peneira:reviewer:([\w.-]+) -->/);
    if (m) { const d = decodeData(body); if (d) store.reviewers[m[1]] = d; continue; }
    m = body.match(/^<!-- peneira:triage:([\w.-]+) -->/);
    if (m) { const d = decodeData(body); if (d) store.triage[m[1]] = d.decisions || {}; }
  }
  return store;
}

export const withData = (markdown, data) => `${markdown}\n\n${encodeData(data)}`;
