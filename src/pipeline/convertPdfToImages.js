import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Rasterizes every page of a PDF into individual image files using poppler's
 * `pdftoppm` CLI. This is a system dependency, not an npm package:
 *
 *   Debian/Ubuntu: apt-get install poppler-utils
 *   macOS:         brew install poppler
 *   Docker:        add `poppler-utils` to your base image's apt-get layer
 *
 * Why a CLI tool instead of a pure-JS PDF library: page rasterization quality
 * (fonts, embedded images, color accuracy) from pure-JS renderers is
 * inconsistent for production-grade print PDFs, whereas poppler is the same
 * battle-tested renderer used by most desktop PDF viewers on Linux.
 *
 * @returns {Promise<string[]>} absolute paths to the generated page images, in page order
 */
export async function convertPdfToImages(pdfPath, outDir, { dpi = 150, format = 'jpeg' } = {}) {
  await fs.promises.mkdir(outDir, { recursive: true });
  const prefix = path.join(outDir, 'pg');
  const formatFlag = format === 'png' ? '-png' : '-jpeg';

  await execFileAsync('pdftoppm', [formatFlag, '-r', String(dpi), pdfPath, prefix]);

  const files = (await fs.promises.readdir(outDir))
    .filter(f => f.startsWith('pg') && (f.endsWith('.jpg') || f.endsWith('.png')))
    .sort(); // pdftoppm zero-pads by default (pg-01.jpg, pg-02.jpg, ...), so lexical sort == page order

  if (!files.length) {
    throw new Error(`pdftoppm produced no output for ${pdfPath} — is the PDF valid?`);
  }
  return files.map(f => path.join(outDir, f));
}
