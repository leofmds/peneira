// Default review skills, ranked by skills.sh installs and repo stars (late 2026).
// The first one installed is the reviewer. The built-in prompt is the backup.
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

export const REVIEW_SKILL_NAMES = REVIEW_SKILLS.map((s) => s.name);

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
  const wanted = REVIEW_SKILLS.filter((s) => names?.includes(s.name));
  if (!wanted.length) return null;
  return `No review skill installed. Using the built-in prompt.\n${wanted.map((s) => `  ${s.install}`).join('\n')}`;
}
