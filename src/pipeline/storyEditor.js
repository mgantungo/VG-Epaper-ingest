/**
 * File:      /var/www/VGEpaper/apps/ingest/src/pipeline/storyEditor.js
 * Repo path: apps/ingest/src/pipeline/storyEditor.js
 * System:    apps/ingest (Express, port 4158)          NEW FILE
 *
 * Manual story editing for the handle app (reached via middleware):
 *   getEditorState   page + its stories + completeness ledger + overlays
 *   compilePreview   text compiled from drawn regions, nothing saved
 *   saveManualStory  create/update a manual story; auto stories it covers
 *                    (>= 50% of their words) become drop_pending
 *   setStoryState    keep / drop / restore
 *   reconcilePage    called by runIngest after re-ingesting a page: auto
 *                    stories covered by a manual story are dropped, ledger saved
 *
 * Every write recomputes the page ledger and stores it on the Page
 * (extractionStatus + extractionLedger).
 *
 * Story fields: uses the existing source (auto_detected|manual) and
 * top/left/width/height, plus new layout (json), reviewState
 * (active|drop_pending|dropped) and supersededBy (string). Page fields:
 * new extractionStatus + extractionLedger. See FILES.md §1–§2.
 */
import { getPageLayout } from './layoutCache.js';
import { compileFromLayout, computeLedgerForStories, describeExclusions } from './extractSections.js';

const COVER_RATIO = 0.5;
const MAX_REGIONS = 40;

// ---- Strapi REST ------------------------------------------------------------
async function strapi(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${process.env.STRAPI_URL || 'http://localhost:1397'}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.STRAPI_API_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`Strapi ${method} ${pathname.split('?')[0]} failed: ${res.status} ${text.slice(0, 300)}`), { status: res.status >= 500 ? 502 : res.status });
  }
  return res.status === 204 ? null : res.json();
}

// Page has draftAndPublish off. Newest first, in case an older ingest left duplicates.
async function findPage(editionDocumentId, pageNumber) {
  const j = await strapi(`/api/pages?filters[edition][documentId][$eq]=${encodeURIComponent(editionDocumentId)}&filters[pageNumber][$eq]=${Number(pageNumber)}&sort=createdAt:desc&pagination[pageSize]=1`);
  if (j?.data?.[0]) return j.data[0];
  throw Object.assign(new Error(`Page ${pageNumber} not found for this edition`), { status: 404 });
}

async function listStories(pageDocumentId) {
  const j = await strapi(`/api/stories?filters[page][documentId][$eq]=${encodeURIComponent(pageDocumentId)}&pagination[pageSize]=200&sort=id:asc`);
  return j?.data || [];
}

const updateStory = (documentId, data) => strapi(`/api/stories/${documentId}?status=published`, { method: 'PUT', body: { data } });
const stateOf = s => s.reviewState || 'active';
const isManual = s => s.source === 'manual';
const cut = (v, n = 255) => (v == null ? v : (String(v).length > n ? `${String(v).slice(0, n - 1)}…` : String(v)));
const regionsOf = s => (s.layout?.length ? s.layout : (s.regions || []).map((r, i) => ({ ...r, role: 'column', order: i })));

// ---- operations --------------------------------------------------------------
export async function getEditorState(editionDocumentId, pageNumber) {
  const page = await findPage(editionDocumentId, pageNumber);
  const [layout, stories] = await Promise.all([getPageLayout(editionDocumentId, pageNumber), listStories(page.documentId)]);
  const active = stories.filter(s => stateOf(s) === 'active');
  const ledger = computeLedgerForStories(layout, active.map(s => ({ documentId: s.documentId, layout: regionsOf(s) })));
  return {
    page: { documentId: page.documentId, pageNumber: page.pageNumber, section: page.section ?? null, extractionStatus: page.extractionStatus ?? null },
    pageSize: { width: layout.width, height: layout.height },
    stories: stories.map(s => ({
      documentId: s.documentId,
      headline: s.headline,
      kicker: s.kicker ?? null,
      byline: s.byline ?? null,
      teaser: s.teaser ?? (s.body || '').slice(0, 220),
      origin: isManual(s) ? 'manual' : 'auto',
      reviewState: stateOf(s),
      supersededBy: s.supersededBy ?? null,
      layout: regionsOf(s)
    })),
    ledger,
    exclusions: describeExclusions(layout)
  };
}

export async function compilePreview(editionDocumentId, pageNumber, layoutRegions) {
  const regions = validateRegions(layoutRegions);
  const layout = await getPageLayout(editionDocumentId, pageNumber);
  const c = compileFromLayout(layout, regions);
  return { headline: c.headline, kicker: c.kicker, byline: c.byline, body: c.body, wordCount: c.wordIds.length, suspiciousJoins: c.suspiciousJoins };
}

export async function saveManualStory(editionDocumentId, pageNumber, { storyDocumentId = null, layout: layoutRegions, headline: headlineOverride = null }) {
  const regions = validateRegions(layoutRegions);
  const page = await findPage(editionDocumentId, pageNumber);
  const layout = await getPageLayout(editionDocumentId, pageNumber);
  const c = compileFromLayout(layout, regions);

  const headline = (headlineOverride || '').trim() || c.headline;
  if (!headline) throw Object.assign(new Error('Draw a title box or type a headline'), { status: 400 });
  if (!c.body) throw Object.assign(new Error('The column boxes contain no text'), { status: 400 });

  const data = {
    headline: cut(headline), kicker: cut(c.kicker), byline: cut(c.byline), teaser: c.teaser, body: c.body,
    top: c.box.top, left: c.box.left, width: c.box.width, height: c.box.height,
    regions: c.regions, layout: c.layout,
    source: 'manual', reviewState: 'active', supersededBy: null, detectionConfidence: 1
  };

  let saved;
  if (storyDocumentId) {
    saved = (await updateStory(storyDocumentId, data)).data;
  } else {
    const create = { ...data, page: page.documentId, ...(page.editionSku ? { editionSku: page.editionSku } : {}) };
    saved = (await strapi('/api/stories?status=published', { method: 'POST', body: { data: create } })).data;
  }

  // Auto stories mostly covered by this one are marked for dropping (editor confirms).
  const mine = new Set(c.wordIds);
  const stories = await listStories(page.documentId);
  for (const s of stories) {
    if (s.documentId === saved.documentId || isManual(s) || stateOf(s) !== 'active') continue;
    if (coverage(layout, regionsOf(s), mine) >= COVER_RATIO) {
      await updateStory(s.documentId, { reviewState: 'drop_pending', supersededBy: saved.documentId });
    }
  }
  await persistLedger(editionDocumentId, pageNumber);
  return { savedDocumentId: saved.documentId, ...(await getEditorState(editionDocumentId, pageNumber)) };
}

export async function setStoryState(editionDocumentId, pageNumber, storyDocumentId, action) {
  const next = { keep: 'active', restore: 'active', drop: 'dropped' }[action];
  if (!next) throw Object.assign(new Error('action must be keep, drop or restore'), { status: 400 });
  await findPage(editionDocumentId, pageNumber); // 404s for a wrong page before touching the story
  await updateStory(storyDocumentId, next === 'active' ? { reviewState: 'active', supersededBy: null } : { reviewState: 'dropped' });
  await persistLedger(editionDocumentId, pageNumber);
  return getEditorState(editionDocumentId, pageNumber);
}

/** After (re-)ingest of one page: auto stories covered by manual ones are dropped, ledger stored. */
export async function reconcilePage(editionDocumentId, pageNumber) {
  const page = await findPage(editionDocumentId, pageNumber);
  const stories = await listStories(page.documentId);
  const manual = stories.filter(s => isManual(s) && stateOf(s) === 'active');
  if (manual.length) {
    const layout = await getPageLayout(editionDocumentId, pageNumber);
    const claimed = new Map();
    for (const m of manual) for (const id of compileFromLayout(layout, regionsOf(m)).wordIds) claimed.set(id, m.documentId);
    for (const s of stories) {
      if (isManual(s) || stateOf(s) !== 'active') continue;
      const ids = compileFromLayout(layout, regionsOf(s)).wordIds;
      const hits = ids.filter(id => claimed.has(id));
      if (ids.length && hits.length / ids.length >= COVER_RATIO) {
        await updateStory(s.documentId, { reviewState: 'dropped', supersededBy: claimed.get(hits[0]) });
      }
    }
  }
  return persistLedger(editionDocumentId, pageNumber);
}

async function persistLedger(editionDocumentId, pageNumber) {
  const page = await findPage(editionDocumentId, pageNumber);
  const [layout, stories] = await Promise.all([getPageLayout(editionDocumentId, pageNumber), listStories(page.documentId)]);
  const active = stories.filter(s => stateOf(s) === 'active');
  const ledger = computeLedgerForStories(layout, active.map(s => ({ documentId: s.documentId, layout: regionsOf(s) })));
  await strapi(`/api/pages/${page.documentId}`, { method: 'PUT', body: { data: { extractionStatus: ledger.status, extractionLedger: ledger } } });
  return ledger;
}

// ---- helpers ---------------------------------------------------------------------
function coverage(layout, regions, claimedIds) {
  const ids = compileFromLayout(layout, regions).wordIds;
  if (!ids.length) return 0;
  return ids.filter(id => claimedIds.has(id)).length / ids.length;
}

function validateRegions(regions) {
  if (!Array.isArray(regions) || !regions.length) throw Object.assign(new Error('Draw at least one column box'), { status: 400 });
  if (regions.length > MAX_REGIONS) throw Object.assign(new Error(`At most ${MAX_REGIONS} boxes per story`), { status: 400 });
  const clean = regions.map((r, i) => {
    const n = k => Number(r[k]);
    const out = { role: r.role === 'title' ? 'title' : 'column', order: Number.isFinite(Number(r.order)) ? Number(r.order) : i, left: n('left'), top: n('top'), width: n('width'), height: n('height') };
    const ok = ['left', 'top', 'width', 'height'].every(k => Number.isFinite(out[k])) &&
      out.left >= 0 && out.top >= 0 && out.width > 0 && out.height > 0 && out.left + out.width <= 100.5 && out.top + out.height <= 100.5;
    if (!ok) throw Object.assign(new Error(`Box ${i + 1} is outside the page`), { status: 400 });
    return out;
  });
  if (!clean.some(r => r.role === 'column')) throw Object.assign(new Error('Add at least one column box'), { status: 400 });
  return clean;
}
