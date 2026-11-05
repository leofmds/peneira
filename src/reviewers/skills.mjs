// Known review skills, ranked by skills.sh installs and repo stars (late 2026).
// Install hints for skills named in reviewers.llm.skills (opt-in; the built-in prompt is the default).
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const REVIEW_SKILLS = [
  {
    name: 'code-review',
    repo: 'mattpocock/skills',
    install: 'npx skills add mattpocock/skills --skill code-review -g -y',
  },
  {
    name: 'requesting-code-review',
    repo: 'obra/superpowers',
    install: 'npx skills add obra/superpowers --skill requesting-code-review -g -y',
  },
  {
    name: 'code-review-and-quality',
    repo: 'addyosmani/agent-skills',
    install: 'npx skills add addyosmani/agent-skills --skill code-review-and-quality -g -y',
  },
];

const SKILL_DIRS = ['.agents/skills', '.claude/skills', '.cursor/skills'];

export function findSkill(name, cwd, env = {}) {
  const roots = [cwd, env.HOME].filter(Boolean);
  for (const root of roots) {
    for (const dir of SKILL_DIRS) {
      const path = join(root, dir, name, 'SKILL.md');
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** First installed skill in list order. ponytail: one skill per run. Ceiling: the rest never run. Upgrade: one pass per installed skill. */
export function resolveReviewSkill(names, cwd, env) {
  for (const name of names || []) {
    const path = findSkill(name, cwd, env);
    if (path) return { name, path };
  }
  return null;
}

export function installHint(names) {
  if (!names?.length) return null;
  const lines = names.map((name) => {
    const known = REVIEW_SKILLS.find((s) => s.name === name);
    return known
      ? `  ${known.install}`
      : `  ${name}: SKILL.md at .agents/skills/${name}/SKILL.md (or .claude/skills, .cursor/skills; in the repo or under your home directory)`;
  });
  return `No review skill installed. Using the built-in prompt.\n${lines.join('\n')}`;
}
