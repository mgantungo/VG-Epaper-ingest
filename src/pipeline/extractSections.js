/**
 * File:      /var/www/VGEpaper/apps/ingest/src/pipeline/extractSections.js
 * Repo path: apps/ingest/src/pipeline/extractSections.js
 * System:    apps/ingest (Express, port 4158)
 *
 * Page layout analysis for native-text edition PDFs: turns pdftotext -bbox
 * words (plus rect/image geometry from scripts/detect_boxes.py) into one or
 * more story candidates per page, and a completeness ledger per page.
 *
 * Pipeline per page (every word ends up in exactly one bucket):
 *   1. furniture   header band (folio, section name, date)
 *   2. zones       boxes classified as graphic / advert / sidebar; large
 *                  images carrying contact details are adverts
 *   3. drop caps   merged into the first word they belong to ("T"+"he")
 *   4. headings    words >= 1.35x body height, stacked rows merged into one
 *                  heading block; kickers and pull quotes separated out
 *   5. columns     gutters found per horizontal band from body-word
 *                  coverage, so a line can never span two columns
 *   6. segments    vertical runs of lines inside one column
 *   7. ownership   a segment belongs to the nearest headline above it that
 *                  covers it horizontally; otherwise to the story in the
 *                  column to its left; otherwise a headless candidate
 *   8. order       each story reads its columns left to right, each column
 *                  top to bottom
 *   9. ledger      counts per bucket, unassigned lines, suspicious joins
 *
 * Also exports loadPageLayout / compileFromLayout / computeLedgerForStories
 * for the manual story editor (see src/pipeline/storyEditor.js).
 *
 * Output shape stays compatible with runIngest.js/strapiClient.js:
 * headline, kicker, byline, teaser, body, box, regions, detectionConfidence,
 * continuesToPage, continuesFromPage are unchanged. New, ignored by callers
 * that don't know them yet: candidate.layout, candidate.kind, page.ledger.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// Fallback only, when the caller has no per-publication list (see runIngest.js).
export const DEFAULT_PUBLICATION_SECTIONS = [
  'Adverts', 'Beat', 'Business', 'Business Vision', 'CSI', 'Case Files', 'Classified',
  'Comments', 'Community News', 'Court', 'Crocs', 'Election News', 'Feature', 'Green UG',
  'Harvest Money', 'Health', 'Her Vision', 'Homes', 'International News', 'JobMart',
  'Leisure', 'Letters', 'Lifestyle', 'Motor Mart', 'Mwalimu', 'NIE', 'National News',
  'New Era', 'News', 'OPED', 'Oil, Gas and Infrastructure', 'Opportunities', 'PLE',
  'OLEVEL', 'ALEVEL', 'Pakasa', 'Relationships', 'Schools', 'Series', 'Special Report',
  'Sport', 'Spotlight', 'Supplements', 'Teen Vision', 'TV and Leisure', 'The Hot Sport',
  'Weekend Xtra', 'Muslim News', 'Back Cover Page'
];

const JUMP_LINE_PATTERNS = [
  { re: /turn(?:ed)?\s+to\s+page\s*(\d+)/i, direction: 'to' },
  { re: /continued?\s+on\s+page\s*(\d+)/i, direction: 'to' },
  { re: /continued?\s+from\s+page\s*(\d+)/i, direction: 'from' },
  { re: /see\s+(?:story\s+)?(?:on\s+)?pages?\s*(\d+)/i, direction: 'to' }
];

const HEADER_BAND_PT = 90;          // top strip holding folio + section name
const HEADLINE_SIZE_RATIO = 1.35;   // heading word height vs body word height
const LINE_OVERLAP_RATIO = 0.5;
const LINE_X_GAP_RATIO = 1.6;
const SEGMENT_GAP_RATIO = 1.8;      // vertical gap (x body height) that ends a column segment
const GUTTER_COVERAGE_RATIO = 0.03; // x-positions covered by <3% of the band's peak count are gutter
const MIN_GUTTER_PT = 4;
const MIN_COLUMN_WIDTH_PT = 40;
const DROP_CAP_RATIO = 2.2;
const PULL_QUOTE_MIN_WORDS = 7;
const PULL_QUOTE_OVERLAP = 0.6;
const CAPTION_MAX_LINES = 4;
const HEADLESS_MIN_WORDS = 25;
const CREDIT_RE = /^(graphic|photo|picture|illustration|cartoon|design)s?\s*(by\b|:)/i;
const CONTACT_PATTERNS = [
  /www\.|https?:\/\//i,
  /\b[\w.-]+@[\w-]+\.[a-z]{2,}/i,
  /\btel\b|\bphone\b|\+256|toll[\s-]?free|\bcall\s+\d/i,
  /p\.?\s?o\.?\s?box/i
];

// ===========================================================================
// Entry points
// ===========================================================================

export async function extractSections(pdfPath, workDir, knownSections = DEFAULT_PUBLICATION_SECTIONS, skipExtractionSections = new Set()) {
  const bboxPath = `${workDir}/layout.xml`;
  await execFileAsync('pdftotext', ['-bbox', pdfPath, bboxPath]);
  const xml = await fs.promises.readFile(bboxPath, 'utf8');
  const pages = parseBboxXmlIntoPages(xml);

  const results = [];
  for (const page of pages) {
    const regions = await detectRegions(pdfPath, page.pageNumber).catch(err => {
      console.warn(`[extractSections] box/image detection failed for page ${page.pageNumber}, continuing without it:`, err.message);
      return { boxes: [], images: [] };
    });
    const layout = { pageNumber: page.pageNumber, width: page.width, height: page.height, words: page.words, boxes: regions.boxes || [], images: regions.images || [] };
    try {
      const a = analyzeLayout(layout, { isCover: page.pageNumber === 1, knownSections, skipExtractionSections });
      results.push({ pageNumber: page.pageNumber, section: a.section, candidates: a.candidates, ledger: a.ledger });
    } catch (err) {
      // One odd page must never abort the whole edition.
      console.error(`[extractSections] analysis failed for page ${page.pageNumber}, continuing with no detected stories for it:`, err.message);
      results.push({ pageNumber: page.pageNumber, section: null, candidates: [], ledger: { status: 'needs_review', error: err.message } });
    }
  }
  return results;
}

/** Words + geometry for one page, in PDF points. Used by the editor's layout cache. */
export async function loadPageLayout(pdfPath, pageNumber) {
  const tmp = path.join(os.tmpdir(), `bbox-${process.pid}-${Date.now()}-${pageNumber}.xml`);
  await execFileAsync('pdftotext', ['-bbox', '-f', String(pageNumber), '-l', String(pageNumber), pdfPath, tmp]);
  const xml = await fs.promises.readFile(tmp, 'utf8');
  await fs.promises.unlink(tmp).catch(() => {});
  const page = parseBboxXmlIntoPages(xml)[0];
  if (!page) throw new Error(`No page ${pageNumber} found`);
  const regions = await detectRegions(pdfPath, pageNumber).catch(err => {
    console.warn(`[loadPageLayout] box/image detection failed for page ${pageNumber}:`, err.message);
    return { boxes: [], images: [] };
  });
  return { pageNumber, width: page.width, height: page.height, words: page.words, boxes: regions.boxes || [], images: regions.images || [] };
}

/** Debug entry point for scripts/visualize_extraction.mjs. */
export async function analyzePageForVisualization(pdfPath, pageNumber, knownSections = DEFAULT_PUBLICATION_SECTIONS) {
  const layout = await loadPageLayout(pdfPath, pageNumber);
  const result = analyzeLayout(layout, { isCover: pageNumber === 1, knownSections });
  return { ...result, pageWidth: layout.width, pageHeight: layout.height, rawBoxes: layout.boxes, rawImages: layout.images };
}

// ===========================================================================
// Page analysis
// ===========================================================================

export function analyzeLayout(layout, opts = {}) {
  const ctx = prepareLayout(layout);
  const r = runAnalysis(ctx, opts);
  return { pageNumber: layout.pageNumber, ...r, ledger: buildLedger(ctx, r.candidates, r.skipped ? 'skipped' : null) };
}

function runAnalysis(ctx, { isCover = false, knownSections = DEFAULT_PUBLICATION_SECTIONS, skipExtractionSections = new Set() } = {}) {
  const { words } = ctx;
  const bandWords = words.filter(w => w.merged === null && w.y1 <= HEADER_BAND_PT);
  for (const w of bandWords) w.bucket = 'furniture';
  const bandLines = groupWordsIntoLines(bandWords, () => 'band');
  const section = detectSectionHeader(bandLines, isCover, knownSections);

  if (section && skipExtractionSections?.has(section.toLowerCase())) {
    for (const w of words) if (!w.bucket && w.merged === null) w.bucket = 'skipped';
    return { section, candidates: [], lines: bandLines, blocks: [], skipped: true };
  }

  applyZones(ctx);

  const candidates = [];
  const allLines = [...bandLines];
  const allBlocks = [];
  const flow = analyzeRegion(ctx, words.filter(w => !w.bucket && w.merged === null && w.boxIdx === null), null);
  candidates.push(...flow.candidates); allLines.push(...flow.lines); allBlocks.push(...flow.blocks);
  ctx.zones.sidebars.forEach((box, idx) => {
    const r = analyzeRegion(ctx, words.filter(w => !w.bucket && w.merged === null && w.boxIdx === idx), idx);
    candidates.push(...r.candidates); allLines.push(...r.lines); allBlocks.push(...r.blocks);
  });

  // Last line of defence against adverts laid out as live text rather than images.
  const kept = [];
  for (const c of candidates) {
    if (contactHits(`${c.headline} ${c.body}`) >= 2 && c.body.length < 600) {
      for (const id of c._wordIds) words[id].bucket = 'advert';
    } else kept.push(c);
  }
  kept.forEach((c, i) => { for (const id of c._wordIds) { words[id].bucket = 'story'; words[id].story = i; } });
  return { section, candidates: kept, lines: allLines, blocks: allBlocks, skipped: false };
}

function prepareLayout(layout) {
  const words = layout.words.map((w, id) => ({
    x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, h: w.y1 - w.y0, text: w.text,
    id, bucket: null, boxIdx: null, merged: null, story: null
  }));
  const bodyH = median(words.filter(w => w.y1 > HEADER_BAND_PT).map(w => w.h)) || 9;
  const counts = new Map();
  for (const w of words) { const k = normWord(w.text); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
  const ctx = { layout, words, W: layout.width, H: layout.height, bodyH, counts, zones: { graphics: [], adverts: [], sidebars: [], images: [] } };
  mergeDropCaps(ctx);
  return ctx;
}

// "T" (30pt) + "he" (8.5pt) -> "The". "A"/"I" are real words, so they only
// merge when the joined form exists elsewhere on the page and the fragment doesn't.
function mergeDropCaps(ctx) {
  const { words, bodyH, counts } = ctx;
  for (const dc of words) {
    if (!/^[“"‘']?[A-Za-z]$/.test(dc.text) || dc.h < bodyH * DROP_CAP_RATIO) continue;
    const host = words
      .filter(w => w !== dc && w.merged === null && w.h < dc.h * 0.6 &&
        w.x0 >= dc.x1 - 2 && w.x0 - dc.x1 <= bodyH * 3 &&
        w.y0 >= dc.y0 - bodyH * 0.6 && w.y0 <= dc.y0 + bodyH * 0.9)
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)[0];
    if (!host) continue;
    let glue = '';
    if (/^[“"‘']?[AI]$/i.test(dc.text)) {
      const joined = normWord(dc.text + host.text);
      const joinedElsewhere = (counts.get(joined) || 0) >= 1;
      const fragmentElsewhere = (counts.get(normWord(host.text)) || 0) > 1;
      if (!joinedElsewhere || fragmentElsewhere) glue = ' ';
    }
    host.text = dc.text + glue + host.text;
    host.x0 = Math.min(host.x0, dc.x0);
    dc.merged = host.id;
  }
}

// ---- zones ------------------------------------------------------------------
function applyZones(ctx) {
  const { layout, words, W, H, bodyH, zones } = ctx;
  const pageArea = W * H;
  zones.images = (layout.images || []).filter(im => area(im) > pageArea * 0.002);

  const boxes = [...(layout.boxes || [])]
    .filter(b => !((b.x1 - b.x0) >= W * 0.85 && (b.y1 - b.y0) >= H * 0.6)) // page / content frames
    .sort((a, b) => area(a) - area(b)); // smallest first, so nested boxes win their own words

  for (const b of boxes) {
    const bw = words.filter(w => !w.bucket && w.merged === null && w.boxIdx === null && centreIn(w, b));
    if (bw.length < 3) continue;
    const headingFrac = bw.filter(w => w.h >= bodyH * HEADLINE_SIZE_RATIO).length / bw.length;
    if (headingFrac >= 0.7) continue; // tinted banner behind a headline: stays in normal flow
    const text = bw.map(w => w.text).join(' ');
    const imgCover = Math.min(1, zones.images.reduce((s, im) => s + intersectArea(b, im), 0) / area(b));
    const lineLens = groupWordsIntoLines(bw, () => 'z').map(l => l.text.length);
    if (contactHits(text) >= 2) { mark(bw, 'advert'); zones.adverts.push(b); }
    else if (imgCover >= 0.15 || median(lineLens) < 28) { mark(bw, 'graphic'); zones.graphics.push(b); }
    else { const idx = zones.sidebars.length; zones.sidebars.push(b); for (const w of bw) w.boxIdx = idx; }
  }

  for (const im of zones.images) {
    if (area(im) < pageArea * 0.06) continue;
    const iw = words.filter(w => !w.bucket && w.merged === null && w.boxIdx === null && centreIn(w, im));
    if (contactHits(iw.map(w => w.text).join(' ')) >= 2) { mark(iw, 'advert'); zones.adverts.push(im); }
  }
}

// ---- one flow region (main page flow, or the inside of one sidebar box) -----
function analyzeRegion(ctx, ws, region) {
  const { bodyH } = ctx;
  if (!ws.length) return { candidates: [], lines: [], blocks: [] };

  const isHeading = w => w.h >= bodyH * HEADLINE_SIZE_RATIO;
  const headLines = groupWordsIntoLines(ws.filter(isHeading), () => 'h');
  for (const l of headLines) { l.region = region; l.column = -1; l.kind = 'heading'; }
  const headBlocks = groupHeadingBlocks(headLines);

  // Bands: every heading block cuts the region horizontally, so gutters are
  // measured only among lines that share the same column grid.
  const cuts = [...new Set(headBlocks.flatMap(b => [b.y0, b.y1]))].sort((a, b) => a - b);
  const bandOf = y => { let i = 0; while (i < cuts.length && y > cuts[i]) i++; return i; };

  const bodyWs = ws.filter(w => !isHeading(w));
  const byBand = groupBy(bodyWs, w => bandOf((w.y0 + w.y1) / 2));
  for (const [band, bw] of byBand) {
    const spans = columnSpans(bw, bodyH);
    for (const w of bw) { w.band = band; w.span = nearestSpan(spans, (w.x0 + w.x1) / 2); }
  }
  const bodyLines = groupWordsIntoLines(bodyWs, w => `${w.band}:${w.span}`);
  for (const l of bodyLines) { l.region = region; l.band = l.words[0].band; l.span = l.words[0].span; l.kind = 'body'; }

  // Credits and captions leave the flow before segmenting.
  for (const l of bodyLines) if (CREDIT_RE.test(l.text.trim())) setKind(l, 'credit');
  markCaptions(ctx, bodyLines);

  const flowLines = bodyLines.filter(l => l.kind === 'body');
  const segments = buildSegments(flowLines, bodyH);

  // Heading roles: kicker / pull quote / headline.
  const bodyText = flowLines.map(l => l.text).join(' ').toLowerCase();
  const maxH = Math.max(0, ...headBlocks.map(b => b.h));
  for (const b of headBlocks) b.role = 'headline';
  for (let i = 0; i < headBlocks.length; i++) {
    const a = headBlocks[i];
    const below = headBlocks.find(b => b !== a && b.y0 >= a.y1 - a.h * 0.3 && b.y0 - a.y1 <= a.h * 1.5 && xOverlap(a, b) > 0 && b.h >= a.h * 1.25);
    if (below) { a.role = 'kicker'; below.kicker = a; }
  }
  for (const b of headBlocks) {
    if (b.role !== 'headline' || b.h >= maxH - 0.01) continue;
    const content = contentWords(b.text);
    if (content.length < PULL_QUOTE_MIN_WORDS) continue;
    const hit = content.filter(t => bodyText.includes(t)).length / content.length;
    if (hit >= PULL_QUOTE_OVERLAP) b.role = 'pullquote';
  }
  for (const b of headBlocks) if (b.role === 'pullquote') for (const l of b.lines) setKind(l, 'pullQuote');

  const heads = headBlocks.filter(b => b.role === 'headline');

  // Ownership.
  for (const s of segments) {
    const owners = heads.filter(h => h.y1 <= s.y0 + bodyH * 0.5 && xOverlap(h, s) >= Math.min(s.x1 - s.x0, h.x1 - h.x0) * 0.5);
    s.owner = owners.sort((a, b) => b.y1 - a.y1)[0] || null;
  }
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const s of segments.filter(x => !x.owner)) {
      const left = segments
        .filter(o => o.owner && o.x1 <= s.x0 + bodyH && o.y0 <= s.y1 && o.y1 >= s.y0 - bodyH * 4)
        .sort((a, b) => (s.x0 - a.x1) - (s.x0 - b.x1))[0];
      if (left) { s.owner = left.owner; changed = true; }
    }
    if (!changed) break;
  }

  const candidates = [];
  for (const h of heads) {
    const segs = segments.filter(s => s.owner === h);
    candidates.push(buildCandidate(ctx, { head: h, segs, region, kind: region === null ? 'story' : 'sidebar' }));
  }
  // Headless: continuations from another page, or sidebars with no heading.
  const orphans = segments.filter(s => !s.owner);
  for (const group of clusterAdjacent(orphans, bodyH)) {
    const n = group.reduce((t, s) => t + s.lines.reduce((u, l) => u + l.words.length, 0), 0);
    if (n < HEADLESS_MIN_WORDS && region === null) continue; // stays unassigned, visible in the ledger
    candidates.push(buildCandidate(ctx, { head: null, segs: group, region, kind: region === null ? 'headless' : 'sidebar' }));
  }

  for (const s of segments) for (const l of s.lines) l.column = s.span;
  const blocks = segments.map(s => ({ lines: s.lines, y0: s.y0, y1: s.y1, x0: s.x0, x1: s.x1, h: bodyH, column: s.span, region, text: s.lines.map(l => l.text).join(' ') }));
  for (const b of headBlocks) blocks.push({ lines: b.lines, y0: b.y0, y1: b.y1, x0: b.x0, x1: b.x1, h: b.h, column: -1, region, role: b.role, text: b.text });
  return { candidates, lines: [...headLines, ...bodyLines], blocks };
}

function buildCandidate(ctx, { head, segs, region, kind }) {
  const { W, H, bodyH } = ctx;
  const ordered = orderSegments(segs);
  const lines = segmentLines(ordered);

  let byline = null;
  const bi = lines.slice(0, 3).findIndex(l => looksLikeByline(l.text));
  if (bi >= 0) { byline = lines[bi].text.replace(/^by\s+/i, '').trim(); lines.splice(bi, 1); }

  const body = assembleText(lines, ctx);
  const kickerBlock = head?.kicker || null;
  let headline = head ? head.text.trim() : null;
  if (!headline) {
    const first = lines[0]?.text || '';
    headline = isSubhead(first) ? first : `${body.split(/\s+/).slice(0, 8).join(' ')}…`;
  }

  const titleRect = head ? unionRect([head, ...(kickerBlock ? [kickerBlock] : [])]) : null;
  const layout = [];
  if (titleRect) layout.push({ role: 'title', order: 0, ...pct(titleRect, W, H) });
  ordered.forEach((s, i) => layout.push({ role: 'column', order: i + 1, ...pct(s, W, H) }));

  const wordLines = [...(head ? head.lines : []), ...(kickerBlock ? kickerBlock.lines : []), ...ordered.flatMap(s => s.lines)];
  const wordIds = [];
  for (const l of wordLines) for (const w of l.words) { wordIds.push(w.id); for (const m of ctx.words) if (m.merged === w.id) wordIds.push(m.id); }

  const jump = detectJumpLine(body);
  const allRects = [...(titleRect ? [titleRect] : []), ...ordered];
  return {
    headline,
    kicker: kickerBlock ? kickerBlock.text.trim() : null,
    byline,
    teaser: body.slice(0, 220),
    body,
    box: allRects.length ? pct(unionRect(allRects), W, H) : { top: 0, left: 0, width: 0, height: 0 },
    regions: allRects.map(r => pct(r, W, H)),
    layout,
    kind,
    detectionConfidence: head ? clamp(round2((head.h / bodyH - 1) / HEADLINE_SIZE_RATIO), 0, 1) : 0.1,
    continuesToPage: jump?.direction === 'to' ? jump.page : null,
    continuesFromPage: jump?.direction === 'from' ? jump.page : null,
    suspiciousJoins: findSuspiciousJoins(ordered),
    _wordIds: wordIds,
    _debugLines: wordLines,
    _debugFromBoxRegion: region !== null
  };
}

// ===========================================================================
// Manual editor support
// ===========================================================================

/**
 * Compile a story from editor-drawn regions (percent of page), in order.
 * title regions -> kicker/headline by size; column regions -> read as
 * columns (gutters detected inside the region, so a region accidentally
 * drawn across two columns still reads left column first).
 * `taken` (optional Set of word ids) lets the ledger detect overlaps.
 */
export function compileFromLayout(layout, regionsPct, { taken = null } = {}) {
  const ctx = prepareLayout(layout);
  const { W, H, bodyH } = ctx;
  const claimed = taken || new Set();
  const wordIds = [];
  let duplicates = 0;
  const titleLines = [];
  const segs = [];

  const ordered = [...regionsPct].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const r of ordered) {
    const rect = fromPct(r, W, H);
    const ws = ctx.words.filter(w => w.merged === null && centreIn(w, rect));
    for (const w of ws) {
      if (claimed.has(w.id)) duplicates++;
      claimed.add(w.id); wordIds.push(w.id);
      for (const m of ctx.words) if (m.merged === w.id) { claimed.add(m.id); wordIds.push(m.id); }
    }
    if (r.role === 'title') { titleLines.push(...groupWordsIntoLines(ws, () => 't')); continue; }
    const spans = columnSpans(ws, bodyH);
    for (const w of ws) w.span = nearestSpan(spans, (w.x0 + w.x1) / 2);
    const lines = groupWordsIntoLines(ws, w => String(w.span));
    for (let i = 0; i < spans.length; i++) {
      const colLines = lines.filter(l => l.words[0].span === i).sort((a, b) => a.y0 - b.y0);
      if (colLines.length) segs.push({ lines: colLines, ...unionRect(colLines) });
    }
  }

  titleLines.sort((a, b) => a.y0 - b.y0);
  const maxH = Math.max(0, ...titleLines.map(l => l.h));
  const firstBig = titleLines.findIndex(l => l.h >= maxH * 0.75);
  const kicker = firstBig > 0 ? titleLines.slice(0, firstBig).map(l => l.text).join(' ').trim() : null;
  const headline = titleLines.slice(Math.max(firstBig, 0)).map(l => l.text).join(' ').trim() || null;

  const lines = segmentLines(segs);
  let byline = null;
  const bi = lines.slice(0, 3).findIndex(l => looksLikeByline(l.text));
  if (bi >= 0) { byline = lines[bi].text.replace(/^by\s+/i, '').trim(); lines.splice(bi, 1); }
  const body = assembleText(lines, ctx);

  const rects = ordered.map(r => fromPct(r, W, H));
  return {
    headline, kicker, byline, body,
    teaser: body.slice(0, 220),
    box: rects.length ? pct(unionRect(rects), W, H) : { top: 0, left: 0, width: 0, height: 0 },
    regions: ordered.map(r => ({ top: r.top, left: r.left, width: r.width, height: r.height })),
    layout: ordered.map((r, i) => ({ role: r.role === 'title' ? 'title' : 'column', order: i, top: r.top, left: r.left, width: r.width, height: r.height })),
    suspiciousJoins: findSuspiciousJoins(segs),
    wordIds, duplicates
  };
}

/**
 * Ledger for a page given its saved stories (active ones only). Words the
 * auto pass classed as furniture/graphic/advert/caption/credit/pull quote
 * stay excluded; every other word must be claimed by exactly one story.
 * stories: [{ documentId, layout?: [...], regions?: [...] }]
 */
export function computeLedgerForStories(layout, stories) {
  const auto = autoBuckets(layout);
  const ctx = prepareLayout(layout);
  for (const w of ctx.words) {
    const b = auto[w.id];
    w.bucket = (b === 'story' || b === null) ? null : b; // exclusions stay, story claims come from saved stories only
  }
  const taken = new Set();
  let duplicates = 0;
  const perStory = [];
  for (const s of stories) {
    const regions = s.layout?.length ? s.layout : (s.regions || []).map((r, i) => ({ ...r, role: 'column', order: i }));
    const c = compileFromLayout(layout, regions, { taken });
    duplicates += c.duplicates;
    for (const id of c.wordIds) { ctx.words[id].bucket = 'story'; ctx.words[id].story = s.documentId; }
    perStory.push({ documentId: s.documentId, words: c.wordIds.length, duplicates: c.duplicates, suspiciousJoins: c.suspiciousJoins });
  }
  const ledger = buildLedger(ctx, [], null, duplicates);
  ledger.storyCount = stories.length;
  ledger.stories = perStory;
  return ledger;
}

/** Excluded-region overlays for the editor canvas (percent of page). */
export function describeExclusions(layout) {
  const auto = autoBuckets(layout);
  const ctx = prepareLayout(layout);
  const out = [];
  for (const kind of ['graphic', 'advert', 'caption', 'credit', 'pullQuote', 'furniture']) {
    const ws = ctx.words.filter(w => w.merged === null && auto[w.id] === kind);
    for (const l of groupWordsIntoLines(ws, () => kind)) out.push({ kind, text: l.text.slice(0, 80), ...pct(l, ctx.W, ctx.H) });
  }
  return out;
}

function autoBuckets(layout) {
  const ctx = prepareLayout(layout);
  runAnalysis(ctx, {});
  return ctx.words.map(w => (w.merged !== null ? ctx.words[w.merged].bucket : w.bucket));
}

// ===========================================================================
// Geometry helpers: lines, headings, columns, segments
// ===========================================================================

function groupWordsIntoLines(words, keyFn) {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    const key = keyFn(w);
    let best = null;
    let bestGap = Infinity;
    for (const l of lines) {
      if (l.key !== key) continue;
      const overlap = Math.min(l.y1, w.y1) - Math.max(l.y0, w.y0);
      const refH = Math.min(l.h, w.h);
      if (overlap <= refH * LINE_OVERLAP_RATIO) continue;
      const gap = w.x0 - l.x1;
      if (gap > refH * LINE_X_GAP_RATIO || gap < -refH * 0.5) continue;
      if (gap < bestGap) { best = l; bestGap = gap; }
    }
    if (best) {
      best.words.push(w);
      best.x1 = Math.max(best.x1, w.x1);
      best.y0 = Math.min(best.y0, w.y0);
      best.y1 = Math.max(best.y1, w.y1);
      best.h = Math.min(best.h, w.h);
    } else {
      lines.push({ key, x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1, h: w.h, region: null, words: [w] });
    }
  }
  for (const l of lines) {
    l.words.sort((a, b) => a.x0 - b.x0);
    l.x0 = l.words[0].x0;
    l.text = joinLineWords(l.words);
  }
  return lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

// pdftotext splits a word after an "fi"/"fl"/"ff" ligature glyph
// ("refi" + "neries"); glue those back when the gap is far tighter than a space.
const LIGATURE_TAIL = /(ff|fi|fl|ffi|ffl)$/i;
function joinLineWords(words) {
  let text = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!i) { text = w.text; continue; }
    const p = words[i - 1];
    const tight = w.x0 - p.x1 < Math.min(p.h, w.h) * 0.15;
    text += (tight && LIGATURE_TAIL.test(p.text) && /^[a-z]/.test(w.text)) ? w.text : ` ${w.text}`;
  }
  return text;
}

// Stacked heading rows ("DPF TO BOLSTER" / "UGANDA'S FINANCIAL" / "SAFETY NET")
// become one block when similar in size, close vertically and overlapping in x.
function groupHeadingBlocks(lines) {
  const blocks = [];
  for (const l of [...lines].sort((a, b) => a.y0 - b.y0)) {
    const b = blocks.find(x => {
      const last = x.lines[x.lines.length - 1];
      const ratio = l.h / last.h;
      return ratio > 0.75 && ratio < 1.33 && l.y0 - last.y1 <= Math.max(l.h, last.h) * 0.9 && l.y0 >= last.y0 && xOverlap(last, l) > 0;
    });
    if (b) { b.lines.push(l); Object.assign(b, unionRect(b.lines)); b.h = Math.max(b.h, l.h); }
    else blocks.push({ lines: [l], ...unionRect([l]), h: l.h });
  }
  for (const b of blocks) b.text = b.lines.map(l => l.text).join(' ');
  return blocks;
}

// Gutters = x positions (almost) never covered by a body word within the band.
function columnSpans(words, bodyH) {
  if (!words.length) return [];
  const minX = Math.floor(Math.min(...words.map(w => w.x0)));
  const maxX = Math.ceil(Math.max(...words.map(w => w.x1)));
  const n = maxX - minX + 1;
  const cov = new Float32Array(n);
  for (const w of words) for (let x = Math.floor(w.x0) - minX; x <= Math.ceil(w.x1) - minX; x++) if (x >= 0 && x < n) cov[x]++;
  const peak = Math.max(...cov);
  const threshold = peak * GUTTER_COVERAGE_RATIO;
  const minGutter = Math.max(MIN_GUTTER_PT, bodyH * 0.45);

  const spans = [];
  let start = 0; let x = 0;
  while (x < n) {
    if (cov[x] <= threshold) {
      let e = x; while (e < n && cov[e] <= threshold) e++;
      if (e - x >= minGutter) { if (x > start) spans.push({ x0: start + minX, x1: x + minX }); start = e; }
      x = e;
    } else x++;
  }
  if (start < n) spans.push({ x0: start + minX, x1: maxX });

  // Fold slivers (a stray bullet or indent) into their neighbour.
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && (s.x1 - s.x0 < MIN_COLUMN_WIDTH_PT || last.x1 - last.x0 < MIN_COLUMN_WIDTH_PT)) last.x1 = s.x1;
    else merged.push({ ...s });
  }
  return merged;
}

function nearestSpan(spans, x) {
  if (!spans.length) return 0;
  let best = 0; let bestD = Infinity;
  spans.forEach((s, i) => { const d = x < s.x0 ? s.x0 - x : x > s.x1 ? x - s.x1 : 0; if (d < bestD) { bestD = d; best = i; } });
  return best;
}

function markCaptions(ctx, lines) {
  const { zones, bodyH } = ctx;
  for (const im of zones.images) {
    const starts = lines.filter(l => l.kind === 'body' &&
      xOverlap(l, im) >= (l.x1 - l.x0) * 0.5 &&
      l.y0 - im.y1 >= -bodyH * 3 && l.y0 - im.y1 <= bodyH * 1.5);
    for (const s of starts) {
      if (s.kind !== 'body') continue;
      setKind(s, 'caption');
      let prev = s; let count = 1;
      const same = lines.filter(l => l.kind === 'body' && l.key === s.key && l.y0 > s.y0).sort((a, b) => a.y0 - b.y0);
      for (const l of same) {
        if (count >= CAPTION_MAX_LINES || l.y0 - prev.y1 > bodyH * 1.2 || xOverlap(l, im) < (l.x1 - l.x0) * 0.5) break;
        setKind(l, 'caption'); prev = l; count++;
      }
    }
  }
}

function buildSegments(lines, bodyH) {
  const segs = [];
  for (const [, ls] of groupBy(lines, l => l.key)) {
    ls.sort((a, b) => a.y0 - b.y0);
    let cur = null;
    for (const l of ls) {
      if (cur && l.y0 - cur.y1 <= bodyH * SEGMENT_GAP_RATIO) { cur.lines.push(l); Object.assign(cur, unionRect(cur.lines)); }
      else { cur = { lines: [l], ...unionRect([l]), band: l.band, span: l.span }; segs.push(cur); }
    }
  }
  return segs;
}

// Columns left to right, each top to bottom. Segments that overlap
// horizontally by half the narrower width are the same column.
function orderSegments(segs) {
  const cols = [];
  for (const s of [...segs].sort((a, b) => a.x0 - b.x0)) {
    const c = cols.find(col => xOverlap(col, s) >= Math.min(col.x1 - col.x0, s.x1 - s.x0) * 0.5);
    if (c) { c.segs.push(s); c.x0 = Math.min(c.x0, s.x0); c.x1 = Math.max(c.x1, s.x1); }
    else cols.push({ x0: s.x0, x1: s.x1, segs: [s] });
  }
  cols.sort((a, b) => a.x0 - b.x0);
  return cols.flatMap(c => c.segs.sort((a, b) => a.y0 - b.y0));
}

function clusterAdjacent(segs, bodyH) {
  const groups = [];
  for (const s of [...segs].sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0)) {
    const g = groups.find(gr => gr.some(o => (Math.abs(o.x0 - s.x1) < bodyH * 3 || Math.abs(s.x0 - o.x1) < bodyH * 3 || xOverlap(o, s) > 0) && o.y0 <= s.y1 + bodyH * 4 && s.y0 <= o.y1 + bodyH * 4));
    if (g) g.push(s); else groups.push([s]);
  }
  return groups;
}

// ===========================================================================
// Text assembly
// ===========================================================================

// Flatten ordered segments into lines, each carrying its segment's text
// margins and line pitch so assembleText can spot paragraph breaks.
// Margins are taken from the bulk of the lines (quartiles), not the extremes,
// so one jutting or indented line doesn't shift the whole column.
function segmentLines(segs) {
  return segs.flatMap(s => {
    const ls = s.lines;
    const x0s = ls.map(l => l.x0).sort((a, b) => a - b);
    const x1s = ls.map(l => l.x1).sort((a, b) => a - b);
    const left = x0s[Math.floor((x0s.length - 1) * 0.25)] ?? s.x0;
    const right = x1s[Math.ceil((x1s.length - 1) * 0.75)] ?? s.x1;
    const pitch = median(ls.slice(1).map((l, i) => l.y0 - ls[i].y0).filter(d => d > 0));
    return ls.map((l, i) => ({ ...l, segStart: i === 0, segX0: s.x0, segLeft: left, segRight: right, segPitch: pitch }));
  });
}

const PARA_END = /[.!?:"”’)…]$/;

// A new paragraph starts before line `l` when the text so far ends a
// sentence AND any of: the line is indented, the previous line stops well
// short of the column's right edge, or there is extra space above the line.
function startsParagraph(l, prev, bodyH, out) {
  if (!prev || !PARA_END.test(out)) return false;
  const width = (l.segRight ?? l.x1) - (l.segLeft ?? l.x0);
  const indent = l.x0 - (l.segLeft ?? l.segX0 ?? l.x0);
  if (indent > bodyH * 0.45 && indent < width * 0.4) return true;
  if (prev.x1 < (prev.segRight ?? prev.x1) - bodyH * 2) return true;
  if (!l.segStart && l.segPitch && l.y0 - prev.y0 > l.segPitch * 1.4) return true;
  return false;
}

function assembleText(lines, ctx) {
  const { bodyH, counts } = ctx;
  let out = '';
  let prev = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = l.text.trim();
    if (!t) continue;
    const sub = isSubhead(t);
    const prevSub = prev ? isSubhead(prev.text.trim()) : false;
    const p = prev;
    prev = l;
    if (!out) { out = t; continue; }
    if (sub || prevSub || startsParagraph(l, p, bodyH, out)) { out += `\n\n${t}`; continue; }
    if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(t)) {
      const tail = out.match(/([A-Za-z]+)-$/)[1];
      const head = t.match(/^[a-z]+/)[0];
      const joined = normWord(tail + head);
      out = (counts.get(joined) || 0) >= 1 ? out.slice(0, -1) + t : out + t;
      continue;
    }
    if (/[A-Za-z]-$/.test(out) && /^[A-Z]/.test(t)) { out += t; continue; } // Anti-|Corruption keeps its hyphen
    out += ` ${t}`;
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

const SENTENCE_STARTERS = /^(The|A|An|He|She|It|They|We|I|This|That|These|Those|But|However|In|On|At|As|According|Meanwhile|Also|And|Currently|Despite|When|While|If)\b/;

function isSubhead(t) {
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length >= 4 && t.length <= 60 && letters === letters.toUpperCase() && !/[.,;]$/.test(t);
}

// A join between two segments looks wrong when the first ends mid-sentence
// and the second starts like a new sentence — reported, never auto-fixed.
function findSuspiciousJoins(orderedSegs) {
  const out = [];
  for (let i = 1; i < orderedSegs.length; i++) {
    const a = orderedSegs[i - 1].lines.at(-1)?.text.trim() || '';
    const b = orderedSegs[i].lines[0]?.text.trim() || '';
    if (/[a-z,]$/.test(a) && SENTENCE_STARTERS.test(b) && !isSubhead(b)) out.push({ after: a.slice(-40), before: b.slice(0, 40) });
  }
  return out;
}

// ===========================================================================
// Ledger
// ===========================================================================

function buildLedger(ctx, candidates, statusOverride = null, duplicates = 0) {
  const { words, W, H } = ctx;
  const buckets = { story: 0, caption: 0, pullQuote: 0, credit: 0, graphic: 0, advert: 0, furniture: 0, skipped: 0, unassigned: 0 };
  const unassigned = [];
  for (const w of words) {
    const b = w.merged !== null ? words[w.merged].bucket : w.bucket;
    const key = b && b in buckets ? b : (b ? 'story' : 'unassigned');
    buckets[key]++;
    if (key === 'unassigned' && w.merged === null) unassigned.push(w);
  }
  const unassignedLines = groupWordsIntoLines(unassigned, () => 'u').map(l => ({ text: l.text.slice(0, 120), ...pct(l, W, H) }));
  const total = words.length;
  const coverageBase = buckets.story + buckets.unassigned;
  const complete = buckets.unassigned <= Math.max(3, total * 0.01) && duplicates === 0;
  return {
    status: statusOverride || (complete ? 'complete' : 'needs_review'),
    totalWords: total,
    buckets,
    duplicates,
    bodyCoverage: coverageBase ? round2(buckets.story / coverageBase) : 1,
    storyCount: candidates.length,
    unassigned: unassignedLines.slice(0, 200),
    suspiciousJoins: candidates.flatMap((c, i) => (c.suspiciousJoins || []).map(j => ({ story: i, ...j })))
  };
}

// ===========================================================================
// Section header, bylines, jump lines (unchanged behaviour)
// ===========================================================================

function detectSectionHeader(lines, isCover, knownSections) {
  if (isCover) return null;
  const bandLines = lines.filter(l => l.y1 <= HEADER_BAND_PT);
  if (!bandLines.length) return null;
  const bandText = bandLines.map(l => l.text).join(' ').toUpperCase().replace(/\s+/g, ' ');
  let matchedSection = null;
  let matchedLength = 0;
  for (const name of knownSections) {
    const needle = name.toUpperCase();
    if (bandText.includes(needle) && needle.length > matchedLength) { matchedSection = name; matchedLength = needle.length; }
  }
  if (matchedSection) return matchedSection;
  const NON_SECTION_LINE_RE = /^(mon|tue|wed|thu|fri|sat|sun)\w*,?$|\b(19|20)\d{2}\b|^photo\s*(by|:)/i;
  const candidateLines = bandLines
    .filter(l => !NON_SECTION_LINE_RE.test(l.text.trim()))
    .filter(l => !/^\d+$/.test(l.text.trim()));
  if (!candidateLines.length) return null;
  const best = candidateLines.reduce((a, b) => (b.h > a.h ? b : a));
  const cleaned = best.text.replace(/^\s*NV\s+/i, '').replace(/^\s*\d+\s+/, '').trim();
  return cleaned || null;
}

function looksLikeByline(text) {
  const m = text.trim().match(/^by\s+(.+)/i);
  if (!m) return false;
  const words = m[1].trim().split(/\s+/);
  return words.length >= 2 && /^[A-Z]/.test(words[0]);
}

function detectJumpLine(text) {
  for (const { re, direction } of JUMP_LINE_PATTERNS) {
    const m = text.match(re);
    if (m) return { direction, page: parseInt(m[1], 10) };
  }
  return null;
}

// ===========================================================================
// PDF plumbing (unchanged)
// ===========================================================================

function resolvePythonCommand() {
  const root = new URL('../../', import.meta.url).pathname; // apps/ingest/
  const venvPython = process.platform === 'win32' ? `${root}venv\\Scripts\\python.exe` : `${root}venv/bin/python3`;
  if (fs.existsSync(venvPython)) return venvPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

async function detectRegions(pdfPath, pageNumber, attempt = 1) {
  const scriptPath = new URL('../../scripts/detect_boxes.py', import.meta.url).pathname;
  try {
    const { stdout } = await execFileAsync(resolvePythonCommand(), [scriptPath, pdfPath, String(pageNumber)], { maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (err) {
    if (attempt < 3) {
      console.warn(`[extractSections] box/image detection attempt ${attempt} failed for page ${pageNumber}, retrying:`, err.message);
      await new Promise(r => setTimeout(r, 300 * attempt));
      return detectRegions(pdfPath, pageNumber, attempt + 1);
    }
    throw err;
  }
}

function parseBboxXmlIntoPages(xml) {
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
  let pageMatch;
  let pageNumber = 0;
  while ((pageMatch = pageRe.exec(xml))) {
    pageNumber += 1;
    const [, w, h, body] = pageMatch;
    const words = [];
    let m;
    wordRe.lastIndex = 0;
    while ((m = wordRe.exec(body))) {
      const [, x0, y0, x1, y1, text] = m;
      const decoded = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");
      if (!decoded.trim()) continue;
      words.push({ x0: parseFloat(x0), y0: parseFloat(y0), x1: parseFloat(x1), y1: parseFloat(y1), h: parseFloat(y1) - parseFloat(y0), text: decoded });
    }
    pages.push({ pageNumber, width: parseFloat(w), height: parseFloat(h), words });
  }
  return pages;
}

// ===========================================================================
// Small utilities
// ===========================================================================

function setKind(line, kind) {
  line.kind = kind;
  for (const w of line.words) w.bucket = kind;
}
function mark(ws, bucket) { for (const w of ws) w.bucket = bucket; }
function contactHits(text) { return CONTACT_PATTERNS.filter(re => re.test(text)).length; }
function contentWords(text) { return text.toLowerCase().split(/[^a-z0-9$%]+/).filter(t => t.length > 3); }
function normWord(t) { return String(t).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function centreIn(w, r) { const cx = (w.x0 + w.x1) / 2; const cy = (w.y0 + w.y1) / 2; return cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1; }
function area(r) { return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0); }
function intersectArea(a, b) { return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)); }
function xOverlap(a, b) { return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)); }
function unionRect(rs) { return { x0: Math.min(...rs.map(r => r.x0)), y0: Math.min(...rs.map(r => r.y0)), x1: Math.max(...rs.map(r => r.x1)), y1: Math.max(...rs.map(r => r.y1)) }; }
function pct(r, W, H) { return { left: round2((r.x0 / W) * 100), top: round2((r.y0 / H) * 100), width: round2(((r.x1 - r.x0) / W) * 100), height: round2(((r.y1 - r.y0) / H) * 100) }; }
function fromPct(r, W, H) { return { x0: (r.left / 100) * W, y0: (r.top / 100) * H, x1: ((r.left + r.width) / 100) * W, y1: ((r.top + r.height) / 100) * H }; }
function groupBy(arr, fn) { const m = new Map(); for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }
function median(nums) { if (!nums.length) return 0; const s = [...nums].sort((a, b) => a - b); const mid = Math.floor(s.length / 2); return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2; }
function round2(n) { return Math.round(n * 100) / 100; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }