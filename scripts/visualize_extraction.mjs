/**
 * apps/ingest/scripts/visualize_extraction.mjs
 *
 * Debug/development tool — never run as part of real ingestion. Renders
 * one page's actual extraction result as colored overlays on the real
 * page image, so a mismatch between what the algorithm saw and what a
 * human expects can be seen directly, the same way the four reference
 * images for this feature were reviewed, rather than reconstructed by
 * reading console output.
 *
 * Color meaning (matches the reference images this was built from):
 *   GREEN — lines belonging to a main-flow story candidate (headline,
 *           kicker, byline, body)
 *   BLUE  — lines belonging to a box-region candidate (a genuine sidebar/
 *           inset, e.g. a fact-box or "PREVIOUS CAUTION"-style callout)
 *   RED   — raw detected images/photos, OR any line that ended up
 *           captured by NO candidate at all (excluded content — a
 *           caption, a dropped pull-quote fragment, anything that fell
 *           through). RED here is a genuine diagnostic signal: if
 *           something under a red box looks like real editorial content
 *           rather than a photo/caption, that's a bug to investigate, not
 *           expected behavior.
 *
 * Usage:
 *   node scripts/visualize_extraction.mjs <pdfPath> <pageNumber> [outDir]
 *
 * Outputs <outDir>/page-<N>-annotated.png (outDir defaults to /tmp).
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzePageForVisualization } from '../src/pipeline/extractSections.js';

const execFileAsync = promisify(execFile);

const [, , pdfPath, pageNumberArg, outDirArg] = process.argv;
if (!pdfPath || !pageNumberArg) {
  console.error('Usage: node scripts/visualize_extraction.mjs <pdfPath> <pageNumber> [outDir]');
  process.exit(1);
}
const pageNumber = parseInt(pageNumberArg, 10);
const outDir = outDirArg || '/tmp';
await fs.promises.mkdir(outDir, { recursive: true });

console.log(`Analyzing page ${pageNumber}...`);
const debug = await analyzePageForVisualization(pdfPath, pageNumber);

console.log(`Rasterizing page ${pageNumber}...`);
const rasterPrefix = path.join(outDir, `page-${pageNumber}-raster`);
await execFileAsync('pdftoppm', ['-jpeg', '-r', '150', '-f', String(pageNumber), '-l', String(pageNumber), pdfPath, rasterPrefix]);
const rasterFile = fs.readdirSync(outDir).find(f => f.startsWith(`page-${pageNumber}-raster`));
if (!rasterFile) throw new Error('pdftoppm did not produce an output file');
const rasterPath = path.join(outDir, rasterFile);

// Annotation rectangles, in PAGE-POINT coordinates — the Python renderer
// scales these against whatever DPI it rasterized at using pageWidth/
// pageHeight, passed through below.
const annotations = [];

function lineKey(l) { return `${l.x0.toFixed(1)},${l.y0.toFixed(1)},${l.x1.toFixed(1)},${l.y1.toFixed(1)}`; }
const unclaimed = new Set(debug.lines.map(lineKey));

for (const img of debug.rawImages) {
  annotations.push({ color: 'red', label: 'image', x0: img.x0, y0: img.y0, x1: img.x1, y1: img.y1 });
}

for (const c of debug.candidates) {
  const color = c._debugFromBoxRegion ? 'blue' : 'green';
  for (const l of c._debugLines || []) unclaimed.delete(lineKey(l));
  for (const r of c.regions || []) {
    annotations.push({
      color,
      label: c.headline.slice(0, 30),
      x0: (r.left / 100) * debug.pageWidth,
      y0: (r.top / 100) * debug.pageHeight,
      x1: ((r.left + r.width) / 100) * debug.pageWidth,
      y1: ((r.top + r.height) / 100) * debug.pageHeight
    });
  }
}

// Whatever's left in `unclaimed` after every candidate's own lines were
// removed is genuinely excluded content — group into contiguous runs
// (same column, close together) so the overlay draws one box per excluded
// passage instead of one per text line.
const unclaimedLines = debug.lines.filter(l => unclaimed.has(lineKey(l)) && l.y0 > 90); // skip the masthead band itself
unclaimedLines.sort((a, b) => (a.column - b.column) || (a.y0 - b.y0));
let run = [];
function flushRun() {
  if (!run.length) return;
  const x0 = Math.min(...run.map(l => l.x0)), x1 = Math.max(...run.map(l => l.x1));
  const y0 = Math.min(...run.map(l => l.y0)), y1 = Math.max(...run.map(l => l.y1));
  annotations.push({ color: 'red', label: 'excluded: ' + run[0].text.slice(0, 25), x0, y0, x1, y1 });
  run = [];
}
for (const l of unclaimedLines) {
  const last = run[run.length - 1];
  if (last && (last.column !== l.column || l.y0 - last.y1 > l.h * 3)) flushRun();
  run.push(l);
}
flushRun();

const dataPath = path.join(outDir, `page-${pageNumber}-annotations.json`);
await fs.promises.writeFile(dataPath, JSON.stringify({
  pageWidth: debug.pageWidth, pageHeight: debug.pageHeight, annotations
}, null, 2));

console.log(`Rendering overlay...`);
const rendererPath = new URL('./render_annotations.py', import.meta.url).pathname;
const outputPath = path.join(outDir, `page-${pageNumber}-annotated.png`);
await execFileAsync('python3', [rendererPath, rasterPath, dataPath, outputPath]);

console.log(`Done: ${outputPath}`);
console.log(`Section detected: ${debug.section || '(none)'}`);
console.log(`Candidates: ${debug.candidates.length}`);
for (const c of debug.candidates) {
  console.log(`  - "${c.headline.slice(0, 60)}" (${c.body?.length || 0} body chars, ${c.regions?.length || 0} regions, ${c._debugFromBoxRegion ? 'sidebar' : 'main-flow'})`);
}
if (unclaimedLines.length) {
  console.log(`${unclaimedLines.length} lines excluded (shown red) — review these for anything that should have been captured.`);
}
