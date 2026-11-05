import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deepMerge } from './util.mjs';
import { REVIEW_SKILL_NAMES } from './reviewers/skills.mjs';

export const CONFIG_PATH = '.peneira/config.json';

export const DEFAULTS = {
  platform: 'github',
  baseBranch: 'main',
  ticket: {
    pattern: '\\b([A-Z][A-Z0-9]{1,9}-\\d+)\\b',
    requiredFor: 'ai',
    urlTemplate: null,
  },
  budget: { maxLogicLines: 400, maxFiles: 10, blockingFor: 'ai' },
  aiDetection: {
    labels: ['ai-generated'],
    branchPrefixes: ['claude/', 'ai/', 'codex/', 'cursor/'],
    commitTrailerPattern: 'co-authored-by:.*(claude|copilot|cursor|codex|devin|gemini|anthropic)',
  },
  templateSections: {
    requiredFor: 'ai',
    sections: ['Intent', 'Assumptions', 'Out of scope / not done', 'How it was verified'],
  },
  ignore: [
    '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/*.snap',
    '**/dist/**', '**/build/**', '**/__generated__/**', '**/*.generated.*', '**/*.min.js',
  ],
  categories: {
    foundation: [
      '**/migrations/**', '**/*.sql', '**/schema*.*', '**/schemas/**', '**/types/**', '**/*.d.ts',
      '**/interfaces/**', '**/config/**', '**/*.config.*', '**/package.json', '**/Dockerfile',
      '**/*.yml', '**/*.yaml',
    ],
    tests: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**', '**/fixtures/**'],
  },
  risk: {
    paths: ['**/auth/**', '**/oauth/**', '**/permissions/**', '**/billing/**', '**/payments/**', '**/migrations/**'],
    addedLinePatterns: [
      '\\b(DROP|TRUNCATE|ALTER)\\s+TABLE\\b',
      '\\bDELETE\\s+FROM\\b',
      'process\\.env\\.[A-Z_]*(SECRET|TOKEN|KEY)',
      '\\b(eval|new Function)\\s*\\(',
    ],
  },
  findings: { visibility: 'summary' },
  // Order is priority: findings are shown in this order, and on overlap the earlier reviewer's finding is kept.
  reviewers: {
    llm: {
      type: 'llm', enabled: true, prefix: 'A', runFor: 'all',
      provider: 'anthropic', model: null, apiKeyEnv: 'REVIEW_API_KEY', maxDiffChars: 120000, focus: null,
      transport: 'auto', skills: REVIEW_SKILL_NAMES,
    },
    ponytail: { type: 'ponytail', enabled: true, prefix: 'P', runFor: 'all', maxTurns: 40, model: null, runner: 'claude' },
  },
  triage: { linearTeamKey: null },
};

export function userConfigPath(env = {}) {
  return env.HOME ? join(env.HOME, '.peneira', 'config.json') : null;
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`${label} is not valid JSON: ${e.message}`); }
}

/** Product defaults, then ~/.peneira/config.json, then the repo file. Later layers win. */
export function loadConfig(cwd, env = {}) {
  let cfg = structuredClone(DEFAULTS);
  const user = userConfigPath(env);
  if (user && existsSync(user)) cfg = deepMerge(cfg, readJson(user, user));
  const repo = join(cwd, CONFIG_PATH);
  if (existsSync(repo)) cfg = deepMerge(cfg, readJson(repo, CONFIG_PATH));
  return cfg;
}

export function ensureUserConfig(env = {}) {
  const p = userConfigPath(env);
  if (!p || existsSync(p)) return p;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify({ reviewers: { llm: { skills: REVIEW_SKILL_NAMES } } }, null, 2)}\n`);
  return p;
}

/** "all" | "ai" | "ai-or-risk" | "none" */
export function appliesTo(scope, { isAI = false, highRisk = false } = {}) {
  return scope === 'all' || (scope === 'ai' && isAI) || (scope === 'ai-or-risk' && (isAI || highRisk));
}
