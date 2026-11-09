---
name: high-signal-review
description: Review a code change for high-signal issues only (bugs that will break, clear CLAUDE.md/AGENTS.md violations), with a separate check of every issue before it is reported. Read-only; never posts.
license: Apache-2.0
---

<!-- Adapted from anthropics/claude-plugins-official plugins/code-review/commands/code-review.md
     at c905cd8fec340e465dd66990b82b95b6e45db212 (Apache-2.0, see LICENSE).
     Changes: headless and read-only (no gh, no posting, no PR-state checks); the diff comes from
     git; bug agents may read code outside the diff to confirm an issue. -->

Review the change between the base and head given to you.

**Agent assumptions (apply to all agents and subagents):**
- All tools work. Do not test tools or make exploratory calls.
- Only call a tool when the task needs it.
- Never modify files, post comments, or call `gh`.

Follow these steps:

1. Launch a haiku agent to return the paths (not contents) of the relevant rules files:
   - the root `CLAUDE.md` and `AGENTS.md`, if they exist
   - any `CLAUDE.md` or `AGENTS.md` in directories that contain files the change modifies

2. Launch a sonnet agent to read `git diff <base>...<head>` and return a summary of the change.

3. Launch 4 agents in parallel to review the change independently. Each returns a list of issues; each issue has a description and the reason it was flagged (e.g. "rules file adherence", "bug"). Give every agent the PR title and description, to understand the author's intent.

   Agents 1 + 2: rules-file compliance (sonnet). Audit the change against the rules files from step 1. For each file, only consider rules files on its path or a parent path.

   Agent 3: bug agent (opus). Scan the diff for obvious bugs. Flag only significant bugs; ignore nitpicks and likely false positives. If an issue depends on code outside the diff (a function's return value, a caller), read that code before flagging it.

   Agent 4: bug agent (opus). Look for problems in the introduced code: security issues, incorrect logic, and so on. Only look for issues that fall within the changed code.

   **CRITICAL: we only want HIGH SIGNAL issues.** Flag issues where:
   - the code will fail to compile or parse (syntax errors, type errors, missing imports, unresolved references)
   - the code will definitely produce wrong results regardless of inputs (clear logic errors)
   - a clear, unambiguous rules-file violation where you can quote the exact rule being broken

   Do NOT flag:
   - code style or quality concerns
   - potential issues that depend on specific inputs or state
   - subjective suggestions or improvements

   If you are not certain an issue is real, do not flag it. False positives erode trust and waste reviewer time.

4. For each issue from step 3, launch a parallel subagent to validate it. Give it the PR title and description and the issue. Its job is to confirm with high confidence that the issue is real: if "variable is not defined" was flagged, check that it really is undefined; for a rules-file issue, check that the rule applies to this file and is actually broken. Use opus for bugs and logic issues, sonnet for rules-file issues.

5. Drop every issue that step 4 did not validate. Merge issues with the same root cause into one.

6. Report the validated issues. For each: the file and lines, a brief description, the evidence (quoted code or the exact rule), and the fix. If nothing survived, say: "No issues found. Checked for bugs and rules-file compliance."

False positives (do NOT flag in steps 3 and 4):
- pre-existing issues
- something that looks like a bug but is actually correct
- pedantic nitpicks a senior engineer would not flag
- issues a linter will catch (do not run the linter to verify)
- general code quality concerns (e.g. lack of test coverage, general security issues) unless a rules file requires it
- issues a rules file mentions but that are explicitly silenced in the code (e.g. a lint ignore comment)
