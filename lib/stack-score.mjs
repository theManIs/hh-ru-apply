import { isItProjectManagerTitle, isSoftwareArchitectTitle } from './filters.mjs';

const FALLBACK_SCORE = 48;

const JUNK =
  /битрикс|bitrix|\b1c\b|1с|qa\b|тест(ир|олог)|дизайнер|преподав|учитель|нутриц|ревит|урбанист|интерьер|wordpress|верстал|стаж[её]р|trainee|\bjunior\b|аналитик|analyst/;

const PHP_FIT =
  /php|laravel|symfony|yii|node\.?\s*js|nestjs|nest\.js|voip|asterisk|freeswitch|телефон|highload|devops/;

const JS_FIT =
  /javascript|typescript|react|vue|nuxt|angular|next\.?\s*js|frontend|react native|expo|\bunity\b/;

const LEAD_FIT =
  /cto|cio|техническ|тимлид|team\s*lead|tech\s*lead|engineering manager|head of engineering|software architect|solution architect|system architect|системный архитектор/;

export function isLlmScoreError(rec) {
  const s = String(rec?.geminiSummary || '');
  return s.startsWith('Ошибка OpenRouter') || s.includes('LLM отключён');
}

export function inferTrackId(title) {
  const t = String(title || '').toLowerCase();
  if (JUNK.test(t)) return null;
  if (/php|laravel|symfony|yii|node\.?\s*js|nestjs|nest\.js|voip|asterisk|freeswitch|телефон/.test(t)) {
    return 'php';
  }
  if (JS_FIT.test(t)) return 'js';
  if (isItProjectManagerTitle(title)) return 'pm';
  if (isSoftwareArchitectTitle(title)) return 'lead';
  if (LEAD_FIT.test(t)) return 'lead';
  if (PHP_FIT.test(t)) return 'php';
  return null;
}

export function titleFitsTrack(title, _trackId) {
  return inferTrackId(title) != null;
}

export function fallbackScores(reason) {
  return {
    score: FALLBACK_SCORE,
    scoreVacancy: FALLBACK_SCORE,
    scoreCvMatch: FALLBACK_SCORE,
    scoreOverall: FALLBACK_SCORE,
    summary: reason,
    risks: '',
    matchCv: 'primary',
    tags: ['fallback-stack'],
    providerModel: 'fallback-stack',
  };
}

export function patchFromLlm(llm) {
  return {
    llmProvider: llm.providerModel === 'fallback-stack' ? 'fallback-stack' : 'openrouter',
    openRouterModel: llm.providerModel || null,
    scoreVacancy: llm.scoreVacancy,
    scoreCvMatch: llm.scoreCvMatch,
    scoreOverall: llm.scoreOverall,
    geminiScore: llm.scoreOverall ?? llm.score,
    geminiSummary: llm.summary,
    geminiRisks: llm.risks,
    geminiMatchCv: llm.matchCv,
    geminiTags: llm.tags,
  };
}
