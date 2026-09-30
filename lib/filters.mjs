import { estimateMonthlyUsd } from './salary-parse.mjs';

function includesAny(text, patterns) {
  const t = text.toLowerCase();
  return patterns.some((p) => t.includes(String(p).toLowerCase()));
}

export function passesRemote(textBlob, prefs) {
  const t = textBlob.toLowerCase();
  const pos = includesAny(t, prefs.remotePositivePatterns || []);
  const hyb = includesAny(t, prefs.hybridPatterns || []);
  const off = includesAny(t, prefs.officeOnlyPatterns || []);

  if (off && !pos) {
    return { pass: false, reason: 'В тексте акцент на офис без явной удалёнки' };
  }
  if (pos) return { pass: true, reason: 'Есть признаки удалённой работы' };
  if (hyb && prefs.allowHybrid) return { pass: true, reason: 'Гибрид (разрешён в preferences)' };
  if (prefs.requireRemote) {
    return { pass: false, reason: 'Нет явной удалёнки/гибрида в описании' };
  }
  return { pass: true, reason: 'Удалёнка не обязательна по настройкам' };
}

export function passesSalary(salaryRaw, prefs) {
  const rub = prefs.rubPerUsd || 98;
  const est = estimateMonthlyUsd(salaryRaw, rub);
  if (!est.ok) {
    if (prefs.allowUnknownSalary) {
      return { pass: true, reason: 'Зарплата не указана — пропущено по allowUnknownSalary', estimate: est };
    }
    return { pass: false, reason: est.note || 'Нет зарплаты', estimate: est };
  }

  const minNeed = prefs.minMonthlyUsd ?? 1500;
  if (est.minUsd >= minNeed) {
    return { pass: true, reason: `Нижняя оценка ≥ ${minNeed} USD/мес`, estimate: est };
  }
  if (est.maxUsd >= minNeed) {
    return {
      pass: true,
      reason: `Вилка задевает ≥ ${minNeed} USD/мес (верх ${est.maxUsd})`,
      estimate: est,
    };
  }

  return {
    pass: false,
    reason: `Оценка ниже порога ${minNeed} USD/мес (≈${est.minUsd}–${est.maxUsd})`,
    estimate: est,
  };
}

function titleNorm(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/salesforce/g, ' ');
}

/** IT / technical / digital project manager — не голый «менеджер проектов». */
export function isItProjectManagerTitle(title) {
  const t = titleNorm(title);
  const isRole =
    /project\s*manager|\bprogram manager\b|проектн\w*\s+менеджер|менеджер\s+\S{0,24}проект|руководитель\s+\S{0,24}проект|технический\s+(руководитель|менеджер)\s+проект/.test(
      t
    );
  if (!isRole) return false;
  const it =
    /\bit\b|\bит\b|информационн|technical|техническ|digital|цифров|software|разработ|web|веб|saas|\bphp\b|javascript|backend|frontend|devops|engineering/.test(
      t
    );
  if (!it) return false;
  if (/продаж|sales|лидоген|онлайн-школ|бетон|пресейл|медиабаер|media buyer/.test(t)) return false;
  return true;
}

export function isSoftwareArchitectTitle(title) {
  const t = titleNorm(title);
  if (!/архитект|\barchitect\b/.test(t)) return false;
  if (/ревит|\brevit\b|урбан|интерьер|жиль|здани|генплан|\bbim\b|ландшафт|проектировщик/.test(t)) {
    return false;
  }
  return /системн\w*\s+архитект|software\s+architect|solution\s+architect|system\s+architect|enterprise\s+architect|data\s+architect|cloud\s+architect|it[-\s]?архитект|ит[-\s]?архитект|информационн|архитектор\s+по(?:\s*$|\s*[/|,;])|архитектор\s+(систем|данных|решений)|php[-\s]?архитект/.test(
    t
  );
}

function isArchitectWordTitle(title) {
  return /архитект|\barchitect\b/.test(titleNorm(title));
}

function patternHits(t, raw) {
  const p = String(raw || '')
    .toLowerCase()
    .trim();
  if (!p) return false;
  const latin = /^[a-z0-9-]+$/.test(p);
  if (!latin) return t.includes(p);
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (p.length <= 4) {
    return new RegExp(`\\b${escaped}\\b`).test(t);
  }
  return t.includes(p);
}

export function passesBlockedTitles(title, patterns = [], allowPatterns = [], extra = {}) {
  const t = titleNorm(title);
  for (const raw of allowPatterns) {
    const a = String(raw || '')
      .toLowerCase()
      .trim();
    if (a && t.includes(a)) return { pass: true, reason: '' };
  }
  if (isItProjectManagerTitle(title)) return { pass: true, reason: '' };
  if (isArchitectWordTitle(title)) {
    if (isSoftwareArchitectTitle(title)) return { pass: true, reason: '' };
    return { pass: false, reason: 'Заголовок: голый архитектор (не IT)' };
  }
  for (const raw of patterns) {
    if (patternHits(t, raw)) {
      return { pass: false, reason: `Заголовок: «${raw}»` };
    }
  }
  const manager = extra.genericManagerPatterns || [];
  const keep = extra.techTitleKeepPatterns || [];
  if (manager.length && manager.some((p) => patternHits(t, p))) {
    if (!keep.some((p) => patternHits(t, p))) {
      return { pass: false, reason: 'Заголовок: не технический руководитель' };
    }
  }
  return { pass: true, reason: '' };
}

export function passesBlockedContent(textBlob, prefs) {
  const t = String(textBlob || '')
    .toLowerCase()
    .replace(/ё/g, 'е');
  for (const raw of prefs.blockContentPatterns || []) {
    if (patternHits(t, raw)) {
      return { pass: false, reason: `Текст: «${raw}»` };
    }
  }
  return { pass: true, reason: '' };
}

export function titlePassesPrefs(title, prefs) {
  return passesBlockedTitles(title, prefs.blockTitlePatterns || [], prefs.allowTitlePatterns || [], {
    genericManagerPatterns: prefs.genericManagerPatterns || [],
    techTitleKeepPatterns: prefs.techTitleKeepPatterns || [],
  });
}

export function passesBlockedLanguages(textBlob, blockLanguages = []) {
  if (!blockLanguages.length) return { pass: true, reason: '' };
  const t = String(textBlob || '')
    .toLowerCase()
    .replace(/javascript/g, ' ');
  const blocks = blockLanguages.map((x) => String(x).toLowerCase());
  if (blocks.includes('python') && /\b(python|django|flask|fastapi)\b/.test(t)) {
    return { pass: false, reason: 'Стек Python' };
  }
  if (blocks.includes('java') && /\b(java|spring|kotlin)\b/.test(t)) {
    return { pass: false, reason: 'Стек Java' };
  }
  return { pass: true, reason: 'Стек не Java/Python или не указан' };
}

export function runHardFilters(parsed, prefs, opts = {}) {
  const blob = [
    parsed.title,
    parsed.company,
    parsed.salaryRaw,
    parsed.employment,
    parsed.address,
    parsed.workFormat,
    parsed.description,
  ]
    .join('\n')
    .toLowerCase();

  let remote = passesRemote(blob, prefs);
  if (
    !remote.pass &&
    opts.remoteFromSearch &&
    !includesAny(blob, prefs.officeOnlyPatterns || [])
  ) {
    remote = { pass: true, reason: 'Удалёнка: фильтр поиска hh' };
  }
  if (!remote.pass) {
    return { pass: false, stage: 'remote', ...remote };
  }

  const salary = passesSalary(parsed.salaryRaw, prefs);
  if (!salary.pass) {
    return { pass: false, stage: 'salary', ...salary };
  }

  const titleBlock = titlePassesPrefs(parsed.title, prefs);
  if (!titleBlock.pass) {
    return { pass: false, stage: 'title', ...titleBlock };
  }

  const contentBlock = passesBlockedContent(blob, prefs);
  if (!contentBlock.pass) {
    return { pass: false, stage: 'content', ...contentBlock };
  }

  if (opts.blockLanguages?.length) {
    const stack = passesBlockedLanguages(blob, opts.blockLanguages);
    if (!stack.pass) {
      return { pass: false, stage: 'stack', ...stack };
    }
  }

  return {
    pass: true,
    remoteReason: remote.reason,
    salaryReason: salary.reason,
    salaryEstimate: salary.estimate,
  };
}
