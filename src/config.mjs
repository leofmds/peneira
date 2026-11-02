import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepMerge } from './util.mjs';

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
  reviewers: {
    ponytail: { type: 'ponytail', enabled: true, prefix: 'P', runFor: 'all', maxTurns: 40, model: null, runner: 'claude' },
    llm: {
      type: 'llm', enabled: true, prefix: 'A', runFor: 'ai-or-risk',
      provider: 'anthropic', model: null, apiKeyEnv: 'REVIEW_API_KEY', maxDiffChars: 120000, focus: null,
    },
  },
  triage: { linearTeamKey: null },
};

export function loadConfig(cwd) {
  const p = join(cwd, CONFIG_PATH);
  if (!existsSync(p)) return structuredClone(DEFAULTS);
  let user;
  try { user = JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`${CONFIG_PATH} is not valid JSON: ${e.message}`); }
  return deepMerge(DEFAULTS, user);
}

/** "all" | "ai" | "ai-or-risk" | "none" */
export function appliesTo(scope, { isAI = false, highRisk = false } = {}) {
  return scope === 'all' || (scope === 'ai' && isAI) || (scope === 'ai-or-risk' && (isAI || highRisk));
}
