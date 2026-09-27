import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * Rebuilt from a direct, tested analysis of two real New Vision PDFs (not
 * assumptions) — see the design conversation this shipped from for the
 * specific failures found and why each fix below exists. Scope is
 * deliberately native-text PDFs only (a real embedded text layer, verified
 * via pdffonts before this ever runs) — no OCR/scanned-PDF path, no .indd.
 *
 * This is still a HEURISTIC, not a guaranteed-correct layout parser — that
 * problem (general newspaper page understanding) is genuinely hard and
 * actively researched in document AI. Every candidate this produces is
 * written to Strapi as source:'auto_detected' and stays in draft until an
 * editor confirms it, same as before. What changed is how much better the
 * candidates are before a human ever looks at them.
 */

// Used as a FALLBACK only, when the caller doesn't supply a per-publication
// known-sections list (see extractSections()'s knownSections parameter
// below) — e.g. New Vision's own list, if runIngest.js's fetch from
// api::publication-section fails for some reason. NOT the source of
// truth: a global fixed list was tried first and rejected specifically
// because it silently dropped any section name belonging to a different
// publication than this one. detectSectionHeader() falls back to the
// actual detected text when nothing here matches, rather than null.
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

// Real phrasings found on actual pages — "Turned to Page 39" / "Continued
// from Page 40" (sports section), plus common variants likely to appear
// elsewhere in a 30-40 page issue this sampling didn't cover. Confidence
// is intentionally binary: a match here means auto-link the pages; no
// match means leave the page's story as its own draft candidate rather
// than guess. A real front-page lead story spanning pages 4-5 was found
// with NO explicit marker at all (just the headline grammatically
// continuing) — that case is not solvable by text pattern matching, and
// this deliberately does not try to guess at it.
const JUMP_LINE_PATTERNS = [
  { re: /turn(?:ed)?\s+to\s+page\s*(\d+)/i, direction: 'to' },
  { re: /continued?\s+on\s+page\s*(\d+)/i, direction: 'to' },
  { re: /continued?\s+from\s+page\s*(\d+)/i, direction: 'from' },
  { re: /see\s+(?:story\s+)?(?:on\s+)?pages?\s*(\d+)/i, direction: 'to' }
];

const LINE_OVERLAP_RATIO = 0.5;    // min vertical box-overlap (of the smaller word's height) to count as "same line"
const LINE_X_GAP_RATIO = 1.6;      // max horizontal gap (relative to text height) before it's a new line, not continued word-spacing
const PARAGRAPH_GAP_RATIO = 1.4;   // vertical gap bigger than this multiple of line height starts a new block
const HEADLINE_SIZE_RATIO = 1.35;  // a block whose height is this many times the page's median body-line height counts as a headline
// Was 14 — genuinely too low for a complete story: a real multi-column
// article can easily have 20-30+ short paragraph blocks once spread
// across 3-4 narrow columns, and that cap was silently truncating longer
// articles rather than capturing them completely. This is a safety net
// against runaway absorption if the NEXT real headline is somehow never
// detected — not meant to be the normal stopping point, which is finding
// that next headline. Raised generously given "completeness over
// ingestion speed" is the explicit priority, not a tight performance bound.
const MAX_BODY_LINES_PER_CANDIDATE = 80;
const HEADER_BAND_PT = 90;         // top-of-page strip searched for the section name — see detectSectionHeader()
const MIN_COLUMN_LINE_COUNT = 5;   // an x0 cluster needs at least this many lines to count as a real column, not stray indentation

export async function extractSections(pdfPath, workDir, knownSections = DEFAULT_PUBLICATION_SECTIONS, skipExtractionSections = new Set()) {
  const bboxPath = `${workDir}/layout.xml`;
  await execFileAsync('pdftotext', ['-bbox', pdfPath, bboxPath]);
  const xml = await fs.promises.readFile(bboxPath, 'utf8');
  const pages = parseBboxXmlIntoPages(xml);

  const results = [];
  for (const page of pages) {
    const regions = await detectRegions(pdfPath, page.pageNumber).catch(err => {
      // Box/image detection is an ENHANCEMENT, not a hard dependency — if
      // the Python helper or pdfplumber isn't available for some reason,
      // degrade to the geometry-only heuristic rather than fail the whole
      // page's extraction. Some accuracy is lost (the headline-beside-
      // sidebar case in particular), not everything.
      console.warn(`[extractSections] box/image detection failed for page ${page.pageNumber}, continuing without it:`, err.message);
      return { boxes: [], images: [] };
    });

    const isCover = page.pageNumber === 1; // covers carry no section name — confirmed on real front pages

    // Same resilience principle as runIngest.js's per-page/per-story
    // wrapping, applied one level earlier: analyzePage() runs the whole
    // line-grouping/column-detection/candidate-building pipeline for one
    // page, and this whole extractSections() call covers every page in
    // one pass, BEFORE runIngest.js's own per-page loop (and its
    // resilience) ever starts. Without this, a layout this hasn't been
    // tested against — a page with no body lines, an unusual box
    // configuration, anything triggering an edge case none of the ~4
    // pages validated so far happened to hit — would abort extraction for
    // the ENTIRE edition, and none of runIngest.js's per-page protection
    // would get a chance to help, since it never even reaches that loop.
    // Degrading to an empty result for just that one page (no section, no
    // candidates — the page image itself still gets uploaded normally)
    // is far better than losing every other page in the issue over it.
    try {
      results.push(analyzePage(page, regions, isCover, knownSections, skipExtractionSections));
    } catch (err) {
      console.error(`[extractSections] analysis failed for page ${page.pageNumber}, continuing with no detected stories for it:`, err.message);
      results.push({ pageNumber: page.pageNumber, section: null, candidates: [] });
    }
  }
  return results;
}

/**
 * Debug-only entry point for one page — returns everything
 * extractSections() computes for that page (section, candidates) PLUS the
 * intermediate detail (every line with its region/column assignment,
 * every block, the raw detected box/image regions) that the production
 * path discards after building candidates. Never called from runIngest.js
 * — this exists for the visualization tool (scripts/visualize_extraction.py)
 * and any other debugging, so a mismatch between what the algorithm
 * actually saw and what it produced can be inspected directly rather than
 * reconstructed by reading console output.
 */
export async function analyzePageForVisualization(pdfPath, pageNumber, knownSections = DEFAULT_PUBLICATION_SECTIONS) {
  const bboxPath = `/tmp/visualize-bbox-${Date.now()}.xml`;
  await execFileAsync('pdftotext', ['-bbox', '-f', String(pageNumber), '-l', String(pageNumber), pdfPath, bboxPath]);
  const xml = await fs.promises.readFile(bboxPath, 'utf8');
  await fs.promises.unlink(bboxPath).catch(() => {});
  const pages = parseBboxXmlIntoPages(xml);
  const page = pages[0];
  if (!page) throw new Error(`No page ${pageNumber} found`);
  page.pageNumber = pageNumber; // parseBboxXmlIntoPages numbers sequentially from 1 within whatever range it parsed — restore the real page number since we only parsed a single-page slice

  const regions = await detectRegions(pdfPath, pageNumber).catch(err => {
    console.warn(`[analyzePageForVisualization] box/image detection failed:`, err.message);
    return { boxes: [], images: [] };
  });

  const isCover = pageNumber === 1;
  const result = analyzePage(page, regions, isCover, knownSections);
  return { ...result, pageWidth: page.width, pageHeight: page.height, rawBoxes: regions.boxes || [], rawImages: regions.images || [] };
}

// Prefers a venv's own Python (apps/ingest/venv/), if one exists, over the
// bare `python3` command — see the deployment conversation this shipped
// from: Ubuntu 24.04+ blocks `pip install` from touching system Python
// directly (PEP 668), and a venv is the correct isolation for a helper
// script with its own dependency (pdfplumber) rather than overriding that
// protection. Falls back to plain `python3` (and `python` on Windows,
// where that's the usual command name) if no venv is present, so this
// still works for a system-wide/--break-system-packages install or any
// other working setup — this is a convenience fallback, not a silent
// requirement to use a venv.
function resolvePythonCommand() {
  const root = new URL('../../', import.meta.url).pathname; // apps/ingest/
  const venvPython = process.platform === 'win32'
    ? `${root}venv\\Scripts\\python.exe`
    : `${root}venv/bin/python3`;
  if (fs.existsSync(venvPython)) return venvPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

// Retried up to 3 times — a subprocess call (spawning Python, opening the
// PDF again for just this page) can fail transiently for reasons that
// have nothing to do with the page's actual content (a momentary resource
// pressure spike, a brief filesystem hiccup) — worth retrying given
// completeness matters more than ingestion speed here, unlike the
// deterministic text-layout algorithm itself, which would just fail the
// same way every time on the same input and gains nothing from a retry.
async function detectRegions(pdfPath, pageNumber, attempt = 1) {
  const scriptPath = new URL('../../scripts/detect_boxes.py', import.meta.url).pathname;
  try {
    const { stdout } = await execFileAsync(resolvePythonCommand(), [scriptPath, pdfPath, String(pageNumber)]);
    return JSON.parse(stdout);
  } catch (err) {
    if (attempt < 3) {
      console.warn(`[extractSections] box/image detection attempt ${attempt} failed for page ${pageNumber}, retrying:`, err.message);
      await new Promise(r => setTimeout(r, 300 * attempt)); // brief, increasing backoff
      return detectRegions(pdfPath, pageNumber, attempt + 1);
    }
    throw err; // exhausted retries — caller's own .catch() degrades to boxes:[]/images:[]
  }
}

// ---- pdftotext -bbox parsing --------------------------------------------
function parseBboxXmlIntoPages(xml) {
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
  let pageMatch;
  let pageNumber = 0;
  while ((pageMatch = pageRe.exec(xml))) {
    pageNumber += 1;
    const [, w, h, body] = pageMatch;
    const width = parseFloat(w);
    const height = parseFloat(h);
    const words = [];
    let wordMatch;
    wordRe.lastIndex = 0;
    while ((wordMatch = wordRe.exec(body))) {
      const [, x0, y0, x1, y1, text] = wordMatch;
      const decoded = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");
      if (!decoded.trim()) continue;
      words.push({
        x0: parseFloat(x0), y0: parseFloat(y0), x1: parseFloat(x1), y1: parseFloat(y1),
        h: parseFloat(y1) - parseFloat(y0),
        text: decoded
      });
    }
    pages.push({ pageNumber, width, height, words });
  }
  return pages;
}

// ---- box-region membership ------------------------------------------------
function regionIndexOf(word, boxes) {
  const cx = (word.x0 + word.x1) / 2;
  const cy = (word.y0 + word.y1) / 2;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1) return i;
  }
  return null;
}

// ---- line grouping ---------------------------------------------------------
// Two fixes over the previous version, both found by testing against a real
// page, not theoretical:
//   1. Vertical compatibility uses actual box OVERLAP against the SMALLER
//      of the two heights, not a tolerance radius derived from the line's
//      own (growing) height — the growing-radius version let a line that
//      absorbed one slightly-taller word become progressively MORE
//      permissive about the next one, eventually merging a headline's two
//      wrapped rows into one, which then wrongly overlapped an unrelated
//      sidebar entirely.
//   2. A word never joins a line whose box-region differs from its own —
//      geometric gap alone can't reliably tell "normal word-spacing"
//      apart from "different container": a real headline and an adjacent
//      sidebar box were only ~17pt apart, well inside normal word-spacing
//      range for that font size. The region check is a hard boundary
//      that doesn't depend on getting a distance threshold exactly right.
function groupWordsIntoLines(words, boxes) {
  for (const w of words) w.region = regionIndexOf(w, boxes);

  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    let best = null;
    let bestGap = Infinity;
    for (const l of lines) {
      if (l.region !== w.region) continue;
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
      best.h = Math.min(best.h, w.h); // deliberately min, not max — keeps the reference height tight instead of inflating
    } else {
      lines.push({ x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1, h: w.h, region: w.region, words: [w] });
    }
  }
  for (const l of lines) {
    l.words.sort((a, b) => a.x0 - b.x0);
    l.text = l.words.map(w => w.text).join(' ');
  }
  return lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

// ---- section header (top band) --------------------------------------------
// Matched against the canonical PUBLICATION_SECTIONS list, not returned as
// free text — a page whose band text doesn't confidently contain one of
// these is left with section: null for an editor to set, rather than
// inventing a value. Covers (page 1) are never checked — confirmed on real
// front pages to carry no section name at all.
// Matched against this publication's own known sections when possible
// (api::publication-section, scoped by publicationCode — see runIngest.js),
// but NOT constrained to that list. A fixed global enum was tried first
// and rejected: it silently dropped any section name belonging to a
// different publication than the one that list was built for. When
// nothing in knownSections matches confidently, this falls back to
// whatever text was actually detected in the header band — cleaned of the
// parts reliably known NOT to be the section name (the date line, the
// page number, the "NV" masthead mark) — rather than returning null and
// losing it.
function detectSectionHeader(lines, isCover, knownSections) {
  if (isCover) return null;
  const bandLines = lines.filter(l => l.y1 <= HEADER_BAND_PT);
  if (!bandLines.length) return null;

  const bandText = bandLines.map(l => l.text).join(' ').toUpperCase().replace(/\s+/g, ' ');

  // Longest match wins — e.g. "Business Vision" should win over a
  // coincidental partial match of plain "Business" if both were ever
  // substrings of the same band text.
  let matchedSection = null;
  let matchedLength = 0;
  for (const name of knownSections) {
    const needle = name.toUpperCase();
    if (bandText.includes(needle) && needle.length > matchedLength) {
      matchedSection = name;
      matchedLength = needle.length;
    }
  }
  if (matchedSection) return matchedSection;

  // No confident match against the known list — fall back to the actual
  // detected text instead of dropping it. A date line ("Friday, September
  // 18, 2026") and a bare page number are the two reliably-identifiable
  // non-section elements in this band; whatever's left, keep. Checking
  // for a weekday name OR a bare 4-digit year separately, rather than
  // requiring the whole line to match one exact date format, catches a
  // date line even if it happens to wrap across two lines on some page's
  // masthead layout (confirmed directly: a full-line date pattern missed
  // a real date on one page, letting it fall through and get picked up as
  // a "section"). A photo-credit line ("Photo by ...") is excluded the
  // same way — also confirmed leaking through on a real page.
  const NON_SECTION_LINE_RE = /^(mon|tue|wed|thu|fri|sat|sun)\w*,?$|\b(19|20)\d{2}\b|^photo\s*(by|:)/i;
  const candidateLines = bandLines
    .filter(l => !NON_SECTION_LINE_RE.test(l.text.trim()))
    .filter(l => !/^\d+$/.test(l.text.trim()));
  if (!candidateLines.length) return null;

  // The section name is typically the most visually prominent remaining
  // text in the band — taller than the date line or a stray page number.
  const best = candidateLines.reduce((a, b) => (b.h > a.h ? b : a));
  const cleaned = best.text.replace(/^\s*NV\s+/i, '').trim(); // strip a leading masthead "NV" mark merged onto the same line
  return cleaned || null;
}

// ---- reading order: segment-then-column ------------------------------
// The previous version assigned every line to a column by nearest x0
// globally across the whole page — this breaks for wide lines (headlines,
// kickers) that don't align with any single body column: a kicker
// starting at the page's left margin and its own headline starting
// further right (indented past it) got assigned to DIFFERENT columns,
// which put them in entirely different places in the reading order and
// severed the story from its own headline. Confirmed directly against a
// real page.
//
// Fix: classify lines as "wide" (spanning meaningfully more than one
// column's typical width — headlines, kickers, banners) or "narrow"
// (body text, fits one column). Wide lines are read in plain Y order and
// never column-clustered. Narrow lines are split into segments at each
// run of wide lines, and column-detection/column-major ordering is
// applied LOCALLY within each segment — not globally across the whole
// page — since two different stories' body columns don't need to share
// one global column grid, only their own segment's.
const WIDE_LINE_RATIO = 1.6;

function buildReadingOrder(bodyLines, medianHeight) {
  const bodySized = bodyLines.filter(l => l.h < medianHeight * 1.2);
  const typicalColumnWidth = median(bodySized.map(l => l.x1 - l.x0)) || 100;

  const sorted = [...bodyLines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  for (const l of sorted) {
    l.wide = (l.x1 - l.x0) > typicalColumnWidth * WIDE_LINE_RATIO;
  }

  const ordered = [];
  let i = 0;
  while (i < sorted.length) {
    if (sorted[i].wide) {
      sorted[i].column = -1; // synthetic shared "column" so consecutive wide lines (a headline's own wrapped rows) still group together in groupLinesIntoBlocks
      ordered.push(sorted[i]);
      i += 1;
      continue;
    }
    // Collect the run of narrow lines up to the next wide line (or end of page).
    const segment = [];
    while (i < sorted.length && !sorted[i].wide) { segment.push(sorted[i]); i += 1; }
    assignLocalColumns(segment);
    segment.sort((a, b) => a.column - b.column || a.y0 - b.y0);
    ordered.push(...segment);
  }
  return ordered;
}

// Dominant-cluster column detection, scoped to one segment's lines only
// (see buildReadingOrder above for why it's no longer global). Clusters
// x0 positions with a 20pt gap threshold, keeps clusters with enough
// lines to be a real column, and reassigns stray/indented lines to their
// nearest surviving cluster.
function assignLocalColumns(lines) {
  const sortedX = [...new Set(lines.map(l => Math.round(l.x0)))].sort((a, b) => a - b);
  const rawClusters = [];
  for (const x of sortedX) {
    const last = rawClusters[rawClusters.length - 1];
    if (last && x - last[last.length - 1] <= 20) last.push(x);
    else rawClusters.push([x]);
  }
  const countFor = c => lines.filter(l => c.includes(Math.round(l.x0))).length;
  const real = rawClusters.filter(c => countFor(c) >= Math.min(MIN_COLUMN_LINE_COUNT, Math.ceil(lines.length / 4)));
  const fallback = real.length ? real : rawClusters;
  const centers = fallback.map(c => (c[0] + c[c.length - 1]) / 2).sort((a, b) => a - b);

  for (const l of lines) {
    let nearest = 0;
    let nearestDist = Infinity;
    centers.forEach((c, idx) => {
      const d = Math.abs(l.x0 - c);
      if (d < nearestDist) { nearestDist = d; nearest = idx; }
    });
    l.column = nearest;
  }
}

// ---- block grouping (paragraphs) within reading order ----------------------
function groupLinesIntoBlocks(orderedLines, medianHeight) {
  const blocks = [];
  for (const line of orderedLines) {
    const last = blocks[blocks.length - 1];
    const gap = last ? line.y0 - last.y1 : 0;
    const sameColumn = last && last.column === line.column;
    const sameSize = last && Math.abs(line.h - last.h) < medianHeight * 0.25;
    // Gap threshold scales against THIS pair's own height, not the page's
    // median body-line height — a large headline's natural line-leading
    // between its own wrapped rows is proportionally much bigger than body
    // text's paragraph gap, and using the page-wide median here was
    // splitting a headline's two rows into separate blocks (confirmed
    // directly: "ISBAT unveils winning strategies" / "for Ultimate
    // University Quiz" — one headline — came out as two candidates).
    // Negative gap (Y-overlap) is allowed up to a point, not rejected
    // outright — large display type routinely produces bounding boxes
    // whose adjacent rows slightly overlap (generous ascender/descender
    // metrics at big sizes) even though they're clearly sequential text to
    // a reader; confirmed directly on this same headline (-13pt "gap"
    // between its two real, sequential rows).
    const gapScale = last ? Math.max(last.h, line.h) : medianHeight;
    // A byline is always a hard block boundary, both ways — it never
    // merges into whatever precedes it, and nothing merges into it
    // afterward. Without this, "By Juliet Kasirye" merged straight into
    // the following paragraph's first line into one block (confirmed
    // directly: the gap between them was small enough to look like a
    // normal paragraph continuation by pure geometry), corrupting the
    // extracted byline field with body text stuck onto the end of it.
    const lastIsByline = last && last.lines.length === 1 && looksLikeByline(last.lines[0].text);
    const thisIsByline = looksLikeByline(line.text);
    if (last && !lastIsByline && !thisIsByline && sameColumn && sameSize && gap >= -gapScale * 0.6 && gap <= gapScale * PARAGRAPH_GAP_RATIO) {
      last.lines.push(line);
      last.y1 = line.y1;
      last.h = Math.max(last.h, line.h);
    } else {
      blocks.push({ lines: [line], y0: line.y0, y1: line.y1, h: line.h, column: line.column, region: line.region });
    }
  }
  for (const b of blocks) b.text = b.lines.map(l => l.text).join(' ');
  return blocks;
}

// ---- caption detection ------------------------------------------------
// A block whose top sits just below a detected image, with meaningful
// horizontal overlap with that image's width, is almost certainly that
// image's caption rather than body/headline text.
function isCaptionBlock(block, images) {
  return images.some(img => {
    const belowGap = block.y0 - img.y1;
    if (belowGap < -5 || belowGap > 20) return false; // must sit essentially right under the image
    const overlapX = Math.min(block.lines[0]?.x1 ?? 0, img.x1) - Math.max(block.lines[0]?.x0 ?? 0, img.x0);
    return overlapX > (img.x1 - img.x0) * 0.3;
  });
}

// ---- per-page analysis ------------------------------------------------
const SIDEBAR_MAX_WIDTH_RATIO = 0.6; // a detected box wider than this fraction of the page is treated as a headline's background styling, not a separate sidebar — see the comment below for why this distinction is necessary

function analyzePage(page, regions, isCover, knownSections, skipExtractionSections) {
  // Not every detected filled/bordered rectangle is a genuine sidebar.
  // Confirmed directly on a real page: a main headline sitting on a
  // tinted background banner (common design treatment for emphasis) was
  // ALSO detected as a "box" by the same rect-detection that correctly
  // finds actual sidebars — and treating it identically (pulled out,
  // processed separately, appended to the very END of the reading order)
  // meant the real headline ended up read dead last on the page, while
  // unrelated body content further down got mistaken for the start of a
  // new story. The distinguishing signal is width: every genuine sidebar
  // seen in testing was comfortably narrow (roughly one column's worth);
  // a headline banner spans most of the page. Only narrow boxes are kept
  // as real sidebar regions — a wide one is discarded here, so its words
  // fall through to normal region: null flow and get read in their
  // correct page position, same as any other line (including being
  // correctly recognized as a wide/banner headline there, which is what
  // should happen).
  const sidebarBoxes = (regions.boxes || []).filter(b => (b.x1 - b.x0) <= page.width * SIDEBAR_MAX_WIDTH_RATIO);
  const { images } = regions;
  const lines = groupWordsIntoLines(page.words, sidebarBoxes);
  const section = detectSectionHeader(lines, isCover, knownSections);

  // Some sections are structurally not editorial content — classified
  // ads, advertorials, puzzle/leisure pages, exam result listings — and
  // running the extraction heuristic on them produces garbled nonsense
  // rather than a story, since there IS no story there to find. Checked
  // by name (case-insensitive) against a caller-supplied set rather than
  // hardcoded here, so it can grow over time through Strapi admin (see
  // api::publication-section's skipStoryExtraction field) without a code
  // change. Returning immediately, before any reading-order/column work,
  // also means this costs nothing extra on a page that's going to be
  // discarded anyway.
  if (section && skipExtractionSections?.has(section.toLowerCase())) {
    return { pageNumber: page.pageNumber, section, candidates: [], lines: [], blocks: [] };
  }

  const bodyLines = lines.filter(l => l.y1 > HEADER_BAND_PT);

  // Reading order: segment-then-column (see buildReadingOrder for why) —
  // this is the actual fix for multi-column text getting scrambled AND
  // for headlines/kickers losing their connection to the story below
  // them, which was the original bug report plus a deeper issue found
  // while testing against real pages. A line sitting inside a detected
  // box region is excluded from the normal flow entirely and handled as
  // its own self-contained candidate afterward, since it's visually and
  // editorially a separate story/sidebar.
  const inFlow = bodyLines.filter(l => l.region === null);
  const boxed = bodyLines.filter(l => l.region !== null);

  const medianHeight = median(bodyLines.map(l => l.h)) || 10;
  const ordered = buildReadingOrder(inFlow, medianHeight);
  const blocks = groupLinesIntoBlocks(ordered, medianHeight);

  // Each box region gets its own independent reading order/blocks, same
  // treatment as the main flow but scoped to just that region's lines.
  const boxRegionIds = [...new Set(boxed.map(l => l.region))];
  for (const regionId of boxRegionIds) {
    const regionLines = boxed.filter(l => l.region === regionId).sort((a, b) => a.y0 - b.y0);
    blocks.push(...groupLinesIntoBlocks(regionLines, medianHeight));
  }

  const candidates = buildStoryCandidates(blocks, medianHeight, images, page.width, page.height);

  // lines/blocks are extra, debug-only detail — the production caller in
  // extractSections() only reads pageNumber/section/candidates from this,
  // so returning more here doesn't change or slow down the real pipeline.
  // A separate debug entry point (see analyzePageForVisualization below)
  // uses this same detail to render what the algorithm actually saw,
  // rather than requiring a human to reconstruct it from console output.
  return { pageNumber: page.pageNumber, section, candidates, lines, blocks };
}

function buildStoryCandidates(blocks, medianHeight, images, pageWidth, pageHeight) {
  const candidates = [];
  const consumed = new Set(); // indices already absorbed as a kicker/byline/body of an earlier candidate — never independently re-processed

  // Pre-pass: identify kickers by comparing each block to the block right
  // after it, not by an absolute height ratio. A kicker clears the
  // body-vs-not-body threshold just like a real headline does (confirmed
  // directly: 21.3pt vs an 11.4pt median, well past HEADLINE_SIZE_RATIO on
  // its own) — what actually distinguishes it is being notably SMALLER
  // than the headline immediately following it in the same column. Doing
  // this as its own pass, before the main loop, is what lets a kicker be
  // marked consumed BEFORE the main loop ever reaches its index and tries
  // to treat it as an independent headline.
  const isHeadlineHeight = b => b.h >= medianHeight * HEADLINE_SIZE_RATIO;
  const kickerFor = new Map(); // headline block index -> kicker text
  for (let i = 0; i < blocks.length - 1; i++) {
    if (consumed.has(i)) continue;
    const b = blocks[i];
    const next = blocks[i + 1];
    if (!isHeadlineHeight(b)) continue; // must at least clear the body-vs-not-body bar to be a kicker candidate
    if (b.column !== next.column) continue;
    const gap = next.y0 - b.y1;
    if (gap < -Math.max(b.h, next.h) * 0.6 || gap > medianHeight * PARAGRAPH_GAP_RATIO * 2) continue; // must sit right above it
    if (next.h < b.h * 1.5) continue; // the following block must be MEANINGFULLY taller — this is the actual kicker-vs-headline signal
    kickerFor.set(i + 1, b.text);
    consumed.add(i);
  }

  for (let i = 0; i < blocks.length; i++) {
    if (consumed.has(i)) continue;
    const block = blocks[i];
    if (isCaptionBlock(block, images)) continue; // captions attach to images, not treated as their own story
    if (looksLikeByline(block.text)) continue; // a byline never starts a candidate on its own — it's absorbed below

    if (!isHeadlineHeight(block)) continue;
    const kicker = kickerFor.get(i) || null;

    let byline = null;
    const bodyLines = [];
    let j = i + 1;
    let sawBodyContent = false;
    while (j < blocks.length && bodyLines.length < MAX_BODY_LINES_PER_CANDIDATE) {
      const next = blocks[j];
      if (next.h >= medianHeight * HEADLINE_SIZE_RATIO) {
        // A large block here is either the NEXT story's real headline, or
        // a pull-quote (a styled excerpt repeated from this story's own
        // body — common design element, no background box the way the
        // sidebar case had, so that earlier box-region fix doesn't catch
        // it). The reliable signal turned out to be width, not "has body
        // content already started flowing" — confirmed directly both
        // ways: a genuine next headline (real case: "PLU welcomes...")
        // measured column === -1 (wide/banner, same classification real
        // headlines get everywhere else in this file), while a real
        // pull-quote fragment measured column === 0 (narrow, sitting
        // within a single column like an inset callout). The earlier
        // "sawBodyContent" check alone wasn't enough on its own — once
        // completeness improvements let a story's body run long enough to
        // actually reach a genuine next headline, that check treated the
        // real headline as a skippable pull-quote too, silently merging
        // two separate stories into one (confirmed directly: ISBAT's body
        // swallowed the entirety of the next story on the same page).
        // Width is checked first and wins regardless of sawBodyContent;
        // the sawBodyContent fallback still guards the case where a
        // narrow-but-large block appears before any body has flowed yet
        // (treated as a genuine headline there too, unchanged from before).
        if (next.column === -1) break;
        if (!sawBodyContent) break;
        consumed.add(j);
        j += 1;
        continue;
      }
      if (isCaptionBlock(next, images)) { j += 1; continue; }
      if (!byline && looksLikeByline(next.text)) {
        byline = next.text.replace(/^by\s+/i, '').trim();
        consumed.add(j);
        j += 1;
        continue;
      }
      bodyLines.push(next);
      sawBodyContent = true;
      consumed.add(j);
      j += 1;
    }

    const bodyText = bodyLines.map(b => b.text).join(' ');
    const jumpLine = detectJumpLine(bodyText);

    const allLines = [block, ...bodyLines].flatMap(b => b.lines);
    candidates.push({
      headline: block.text.trim(),
      kicker,
      byline,
      teaser: bodyText.slice(0, 220),
      body: bodyText, // no arbitrary character cap — see extractSections history; the real bound is MAX_BODY_LINES_PER_CANDIDATE above
      box: boundingBoxOf(allLines, pageWidth, pageHeight), // overall box — kept for any caller that just needs one rectangle
      regions: computeRegions(allLines, pageWidth, pageHeight), // the actual heatmap — one rectangle per column occupied, see computeRegions()'s own comment for why a single box is wrong here
      detectionConfidence: clamp(round2((block.h / medianHeight - 1) / HEADLINE_SIZE_RATIO), 0, 1),
      continuesToPage: jumpLine?.direction === 'to' ? jumpLine.page : null,
      continuesFromPage: jumpLine?.direction === 'from' ? jumpLine.page : null,
      // Debug-only — runIngest.js/strapiClient.js never read these, so
      // they ride along harmlessly in production. Exists so the
      // visualization tool can know exactly which lines this specific
      // candidate claimed, rather than reverse-engineering it from text
      // matching after the fact (fragile — text can legitimately repeat).
      _debugLines: allLines,
      _debugFromBoxRegion: block.region !== null
    });
  }
  return candidates;
}

function detectJumpLine(text) {
  for (const { re, direction } of JUMP_LINE_PATTERNS) {
    const m = text.match(re);
    if (m) return { direction, page: parseInt(m[1], 10) };
  }
  return null;
}

// Percentages of page width/height, matching Story schema's documented
// field meaning ("% from top of the page image", etc.) exactly as the
// pre-existing implementation did — raw PDF-point coordinates would
// silently corrupt every heatmap position on the actual reader.
function boundingBoxOf(lines, pageWidth, pageHeight) {
  if (!lines.length) return { top: 0, left: 0, width: 0, height: 0 };
  const x0 = Math.min(...lines.map(l => l.x0));
  const x1 = Math.max(...lines.map(l => l.x1));
  const y0 = Math.min(...lines.map(l => l.y0));
  const y1 = Math.max(...lines.map(l => l.y1));
  return {
    left: round2((x0 / pageWidth) * 100),
    top: round2((y0 / pageHeight) * 100),
    width: round2(((x1 - x0) / pageWidth) * 100),
    height: round2(((y1 - y0) / pageHeight) * 100)
  };
}

// A single top/left/width/height box is structurally wrong for a story
// spanning multiple columns: it stretches from the leftmost occupied
// column's left edge to the rightmost's right edge, at the FULL height
// needed by whichever column is tallest — meaning it covers the gutters
// between columns, AND any unrelated content sandwiched between them at
// the same Y-range if the columns don't have matching line counts. This
// computes the real heatmap instead: one rectangle per column the story
// actually occupies (a headline's own wide "column" of -1 naturally gets
// its own separate rectangle this same way, since it's grouped by the
// same column id as everything else).
//
// Within one column, a story's lines are a single contiguous run in
// practice — buildStoryCandidates() consumes blocks sequentially, so
// nothing else can be interleaved into the middle of one story's own
// portion of a column. A defensive Y-gap split is still applied in case
// that assumption is ever wrong on some layout not yet seen: a gap much
// larger than the lines' own height starts a new region rather than
// silently stretching one rectangle across an unrelated gap.
const REGION_SPLIT_GAP_RATIO = 4;

function computeRegions(lines, pageWidth, pageHeight) {
  const byColumn = new Map();
  for (const line of lines) {
    const key = line.column;
    if (!byColumn.has(key)) byColumn.set(key, []);
    byColumn.get(key).push(line);
  }

  const regions = [];
  for (const colLines of byColumn.values()) {
    colLines.sort((a, b) => a.y0 - b.y0);
    let run = [];
    for (const line of colLines) {
      const last = run[run.length - 1];
      const gap = last ? line.y0 - last.y1 : 0;
      if (last && gap > last.h * REGION_SPLIT_GAP_RATIO) {
        regions.push(boundingBoxOf(run, pageWidth, pageHeight));
        run = [];
      }
      run.push(line);
    }
    if (run.length) regions.push(boundingBoxOf(run, pageWidth, pageHeight));
  }
  return regions;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function round2(n) { return Math.round(n * 100) / 100; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// A real byline is short and its first word is a capitalized name — "By
// Derrick Muduku". An ordinary sentence that happens to break across a
// block boundary right after the word "by" is not — "by President",
// "by the Government", "by security investigations, providing" all
// matched a bare /^by\s+/i test on a real page, corrupting extracted
// bylines with junk. Checked directly against every real byline AND every
// false positive found in testing: requiring at least 2 words after "by"
// with the first one capitalized separates them cleanly — every genuine
// byline passes both checks, every false positive found fails at least
// one ("President" alone is 1 word; "the Government"/"security
// investigations..."/"your company..."/"the farmer..." all start with a
// lowercase word).
function looksLikeByline(text) {
  const m = text.trim().match(/^by\s+(.+)/i);
  if (!m) return false;
  const words = m[1].trim().split(/\s+/);
  return words.length >= 2 && /^[A-Z]/.test(words[0]);
}