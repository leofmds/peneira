---
description: Review a PR with peneira and triage each finding with me
argument-hint: <PR number, optional>
---

Review pull request $ARGUMENTS with peneira. I decide what gets posted.

1. Run `peneira $ARGUMENTS --list --json` and read the output. If it fails, show me the error
   and stop. Tell me the gate status in one line, plus any blocking items.
2. If there are no findings, say so and stop.
3. Go through the findings in order (Must fix first). For EACH one, show me:
   id, severity, source, location, title, and the Problem / Fix text, quoted from the JSON.
   Then ask me to choose: comment (c), general note (g), ignore (i), or false positive (f,
   optionally with a reason). Ask about one finding at a time. Never decide for me and never
   skip a finding. If I want to reword a comment, tell me to run `peneira $ARGUMENTS` in a
   terminal instead, where I can edit it.
4. When every finding has a decision, show the full list of decisions and ask how to post:
   pending (default), comment, request-changes, or none.
5. Run `peneira $ARGUMENTS --decide "<ID=c,ID=i,ID=f:reason,...>" --submit <mode>` with exactly
   my decisions. Reasons must not contain commas. Show me the command output.

Do not edit any file. Do not post anything except through that final command.
