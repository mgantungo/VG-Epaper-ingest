import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * Turns `pdftotext -bbox` word-position output into candidate story hotspots,
 * using font size (word box height) as the signal that separates headlines
 * from body text — the same visual cue a human skimming the page uses.
 *
 * IMPORTANT — set expectations correctly: this is a heuristic, not a layout
 * model. It will misfire on unusual page designs (multi-deck headlines, pull
 * quotes styled larger than headlines, wrap-around captions, etc). That's why
 * every box it produces is written to Strapi as a **draft** Story with
 * `source: "auto_detected"` — nothing from this pipeline goes live until a
 * human confirms the headline text and adjusts the box in the Strapi admin.
 * Treat detectionConfidence as "how much this block's font-size stood out
 * from the page's body text," not as a guarantee of correctness.
 */
export async function extractSections(pdfPath, workDir) {
  const bboxPath = `${workDir}/layout.xml`;
  await execFileAsync('pdftotext', ['-bbox', pdfPath, bboxPath]);
  const xml = await fs.promises.readFile(bboxPath, 'utf8');
  return parseBboxXmlIntoPages(xml).map(page => ({
    ...page,
    candidates: detectHeadlineBlocks(page)
  }));
}

// ---- pdftotext -bbox parsing --------------------------------------------
// Output looks like:
// <page width="612.00" height="792.00">
//   <word xMin="34.02" yMin="48.11" xMax="120.55" yMax="61.30">HEADLINE</word>
//   ...
// </page>
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
      const decoded = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      if (!decoded.trim()) continue;
      words.push({
        x0: parseFloat(x0), y0: parseFloat(y0), x1: parseFloat(x1), y1: parseFloat(y1),
        height: parseFloat(y1) - parseFloat(y0),
        text: decoded
      });
    }
    pages.push({ pageNumber, width, height, words });
  }
  return pages;
}

// ---- layout heuristic ----------------------------------------------------
const LINE_Y_TOLERANCE_RATIO = 0.5;   // words within this fraction of a line's height count as "same line"
const PARAGRAPH_GAP_RATIO = 1.4;      // a vertical gap bigger than this multiple of line height starts a new block
const HEADLINE_SIZE_RATIO = 1.35;     // a line whose height is this many times the page's median counts as a headline
const MAX_BODY_LINES_PER_CANDIDATE = 14;

function detectHeadlineBlocks(page) {
  if (!page.words.length) return [];

  const lines = groupWordsIntoLines(page.words);
  if (!lines.length) return [];

  const medianLineHeight = median(lines.map(l => l.height));
  const blocks = groupLinesIntoBlocks(lines, medianLineHeight);

  const candidates = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const isHeadline = block.height >= medianLineHeight * HEADLINE_SIZE_RATIO;
    if (!isHeadline) continue;

    // Absorb the following non-headline blocks as this story's body, until
    // the next headline-sized block or a hard cap on how much we sweep in.
    const bodyLines = [];
    let j = i + 1;
    while (j < blocks.length && bodyLines.length < MAX_BODY_LINES_PER_CANDIDATE) {
      const next = blocks[j];
      if (next.height >= medianLineHeight * HEADLINE_SIZE_RATIO) break;
      bodyLines.push(...next.lines);
      j += 1;
    }

    const allLines = [...block.lines, ...bodyLines];
    const box = boundingBoxOf(allLines, page.width, page.height);
    const bodyText = bodyLines.map(l => l.text).join(' ');

    candidates.push({
      headline: block.lines.map(l => l.text).join(' '),
      teaser: bodyText.slice(0, 220),
      // No arbitrary character cap here (an earlier version truncated this
      // to 900 chars, which is what was actually behind "the pullout never
      // shows the complete story" — not a display bug at all). The real,
      // sensible limit is MAX_BODY_LINES_PER_CANDIDATE above, which already
      // bounds how much text gets absorbed based on actual page layout —
      // re-truncating that by raw character count on top was redundant and
      // just cut articles off arbitrarily mid-sentence.
      body: bodyText,
      box,
      detectionConfidence: clamp(round2((block.height / medianLineHeight - 1) / (HEADLINE_SIZE_RATIO)), 0, 1)
    });
  }
  return candidates;
}

function groupWordsIntoLines(words) {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const word of sorted) {
    const line = lines.find(l => Math.abs(l.y0 - word.y0) <= l.height * LINE_Y_TOLERANCE_RATIO);
    if (line) {
      line.words.push(word);
      line.x0 = Math.min(line.x0, word.x0);
      line.x1 = Math.max(line.x1, word.x1);
      line.y0 = Math.min(line.y0, word.y0);
      line.y1 = Math.max(line.y1, word.y1);
      line.height = Math.max(line.height, word.height);
    } else {
      lines.push({ x0: word.x0, x1: word.x1, y0: word.y0, y1: word.y1, height: word.height, words: [word] });
    }
  }
  for (const line of lines) {
    line.words.sort((a, b) => a.x0 - b.x0);
    line.text = line.words.map(w => w.text).join(' ');
  }
  return lines.sort((a, b) => a.y0 - b.y0);
}

function groupLinesIntoBlocks(lines, medianLineHeight) {
  const blocks = [];
  for (const line of lines) {
    const last = blocks[blocks.length - 1];
    const gap = last ? line.y0 - last.y1 : 0;
    const sameSizeAsLast = last && Math.abs(line.height - last.height) < medianLineHeight * 0.25;
    if (last && sameSizeAsLast && gap <= medianLineHeight * PARAGRAPH_GAP_RATIO) {
      last.lines.push(line);
      last.y1 = line.y1;
      last.height = Math.max(last.height, line.height);
    } else {
      blocks.push({ lines: [line], y0: line.y0, y1: line.y1, height: line.height });
    }
  }
  return blocks;
}

function boundingBoxOf(lines, pageWidth, pageHeight) {
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

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function round2(n) { return Math.round(n * 100) / 100; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }