/**
 * File:      /var/www/VGEpaper/apps/ingest/src/pipeline/layoutCache.js
 * Repo path: apps/ingest/src/pipeline/layoutCache.js
 * System:    apps/ingest (Express, port 4158)          NEW FILE
 *
 * Page word/geometry cache for the story editor. The first request for a
 * page downloads the edition PDF once, runs pdftotext + detect_boxes.py for
 * that page, and stores the result as JSON. The cache directory is keyed by
 * the edition's sourcePdf URL, so replacing the PDF invalidates it.
 *
 * Env: LAYOUT_CACHE_DIR (default: $WORK_DIR/layout-cache)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getEdition, downloadSourcePdf } from './strapiClient.js';
import { loadPageLayout } from './extractSections.js';

const inflight = new Map();

function cacheRoot() {
  return process.env.LAYOUT_CACHE_DIR || path.join(process.env.WORK_DIR || '/tmp/newvision-ingest', 'layout-cache');
}

export async function getPageLayout(editionDocumentId, pageNumber) {
  const edition = await getEdition(editionDocumentId);
  const pdfUrl = edition?.sourcePdf?.url;
  if (!pdfUrl) throw Object.assign(new Error('This edition has no source PDF'), { status: 404 });

  const tag = crypto.createHash('sha1').update(pdfUrl).digest('hex').slice(0, 10);
  const dir = path.join(cacheRoot(), editionDocumentId.replace(/[^\w-]/g, ''), tag);
  const file = path.join(dir, `page-${pageNumber}.json`);
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { /* not cached yet */ }

  const key = `${dir}:${pageNumber}`;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    await fs.promises.mkdir(dir, { recursive: true });
    const pdfPath = path.join(dir, 'source.pdf');
    if (!fs.existsSync(pdfPath)) {
      const partial = `${pdfPath}.part-${process.pid}`;
      await downloadSourcePdf(edition, partial);
      await fs.promises.rename(partial, pdfPath);
    }
    const layout = await loadPageLayout(pdfPath, pageNumber);
    await fs.promises.writeFile(file, JSON.stringify(layout));
    return layout;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}