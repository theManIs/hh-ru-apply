import path from 'path';
import { loadSearchKeywords } from './load-keywords.mjs';
import { ROOT } from './paths.mjs';
import { titlePassesPrefs, passesBlockedContent } from './filters.mjs';
import { loadQueue, saveQueue } from './store.mjs';

export function loadTracks(prefs) {
  if (Array.isArray(prefs.hhTracks) && prefs.hhTracks.length) return prefs.hhTracks;
  return [
    {
      id: 'php',
      keywordsFile: 'config/search-keywords.txt',
      hhResumePickPatterns: prefs.hhResumePickPatterns || [],
    },
  ];
}

export function keywordsForTrack(track) {
  if (Array.isArray(track.keywords) && track.keywords.length) return track.keywords;
  const file = path.join(ROOT, track.keywordsFile || 'config/search-keywords.txt');
  return loadSearchKeywords(file);
}

export function resumePatternsForRecord(rec, prefs) {
  const tracks = loadTracks(prefs);
  const id = rec.track || 'php';
  const tr = tracks.find((t) => t.id === id) || tracks[0];
  return tr?.hhResumePickPatterns || prefs.hhResumePickPatterns || [];
}

export function recordPassesPrefs(r, prefs) {
  const title = titlePassesPrefs(r.title, prefs);
  if (!title.pass) return title;
  const blob = [r.title, r.company, r.descriptionPreview, r.descriptionForLlm].join('\n');
  return passesBlockedContent(blob, prefs);
}

export function markBlockedTitles(prefs) {
  const q = loadQueue();
  const now = new Date().toISOString();
  let skipped = 0;
  let restored = 0;
  for (let i = 0; i < q.length; i++) {
    const r = q[i];
    if (r.hhAppliedAt) continue;
    const check = recordPassesPrefs(r, prefs);
    if (!check.pass) {
      if (r.hhApplySkipReason === 'blocked_title' || r.hhApplySkipReason === 'blocked_content') continue;
      if (r.hhApplySkipReason) continue;
      const reason = String(check.reason || '').startsWith('Текст:') ? 'blocked_content' : 'blocked_title';
      q[i] = {
        ...r,
        hhApplySkipReason: reason,
        hhApplySkipNote: check.reason,
        updatedAt: now,
      };
      skipped++;
      continue;
    }
    if (r.hhApplySkipReason === 'blocked_title' || r.hhApplySkipReason === 'blocked_content') {
      const { hhApplySkipReason, hhApplySkipNote, ...rest } = r;
      q[i] = { ...rest, updatedAt: now };
      restored++;
    }
  }
  if (skipped || restored) saveQueue(q);
  return skipped;
}

export function waterfallTargets(queue, prefs, minScore) {
  const tracks = loadTracks(prefs);
  const pending = queue.filter(
    (r) =>
      !r.hhAppliedAt &&
      !r.hhApplySkipReason &&
      (r.scoreOverall ?? r.geminiScore ?? 0) >= minScore &&
      r.url &&
      recordPassesPrefs(r, prefs).pass
  );
  const byScore = (a, b) => (b.scoreOverall ?? 0) - (a.scoreOverall ?? 0);
  const out = [];
  const seen = new Set();
  for (const tr of tracks) {
    const chunk = pending.filter((r) => (r.track || 'php') === tr.id).sort(byScore);
    for (const r of chunk) {
      out.push(r);
      seen.add(r.id);
    }
  }
  for (const r of pending.filter((x) => !seen.has(x.id)).sort(byScore)) out.push(r);
  return out;
}
