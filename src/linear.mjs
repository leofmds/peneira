// Optional Linear integration for the "ticket" triage action.
import { commentBody } from './findings.mjs';

export function linearTicketFactory({ env = process.env, cfg, prUrl, fetchImpl = globalThis.fetch }) {
  if (!env.LINEAR_API_KEY || !cfg.triage?.linearTeamKey) return null;
  let teamId = null;
  const gql = async (query, variables) => {
    const res = await fetchImpl('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: env.LINEAR_API_KEY },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
  };
  return async (f) => {
    if (!teamId) {
      const d = await gql('query($k:String!){ teams(filter:{key:{eq:$k}}){ nodes { id } } }', { k: cfg.triage.linearTeamKey });
      teamId = d.teams.nodes[0]?.id;
      if (!teamId) throw new Error(`Linear team "${cfg.triage.linearTeamKey}" not found`);
    }
    const description = `${commentBody(f, { withLocation: true })}\n\nFound by ${f.source} on ${prUrl}`;
    const d = await gql('mutation($i:IssueCreateInput!){ issueCreate(input:$i){ issue { identifier url } } }',
      { i: { teamId, title: f.title, description } });
    return d.issueCreate.issue;
  };
}
