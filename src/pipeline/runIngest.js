import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import {
  getEdition, downloadSourcePdf, uploadImage, createPage, createDraftStory, updateEditionStatus
} from './strapiClient.js';
import { convertPdfToImages } from './convertPdfToImages.js';
import { extractSections } from './extractSections.js';

const WORK_DIR = process.env.WORK_DIR || '/tmp/newvision-ingest';
const DPI = Number(process.env.PAGE_IMAGE_DPI || 150);
const FORMAT = process.env.PAGE_IMAGE_FORMAT === 'png' ? 'png' : 'jpeg';

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * Full pipeline for one Edition, identified throughout by its Strapi 5
 * `documentId` (a string) — never the legacy numeric `id`:
 *   1. pull the sourcePdf Strapi is holding
 *   2. rasterize every page to an image (pdftoppm)
 *   3. detect candidate story sections per page from text layout (pdftotext -bbox)
 *   4. upload page images + create Page documents
 *   5. create the detected sections as *draft* Story documents for review
 *   6. flip the Edition to ready_for_review (or failed, with the error recorded)
 */
export async function runIngest(editionDocumentId) {
  const runDir = path.join(WORK_DIR, `edition-${editionDocumentId}-${Date.now()}`);
  await fs.promises.mkdir(runDir, { recursive: true });

  try {
    const edition = await getEdition(editionDocumentId);
    const dateLabel = edition.date; // flattened response — no .attributes wrapper in Strapi 5

    const pdfPath = path.join(runDir, 'source.pdf');
    await downloadSourcePdf(edition, pdfPath);

    const imagesDir = path.join(runDir, 'images');
    const imagePaths = await convertPdfToImages(pdfPath, imagesDir, { dpi: DPI, format: FORMAT });

    const sectionsByPage = await extractSections(pdfPath, runDir);
    const sectionsIndex = new Map(sectionsByPage.map(p => [p.pageNumber, p.candidates]));

    let createdStoryCount = 0;
    for (let i = 0; i < imagePaths.length; i++) {
      const pageNumber = i + 1;
      const ext = FORMAT === 'png' ? 'png' : 'jpg';
      const fileName = `edition-${dateLabel}-pg-${pad2(pageNumber)}.${ext}`;

      const imageId = await uploadImage(imagePaths[i], fileName);
      const page = await createPage({ editionDocumentId, pageNumber, section: null, imageId });

      const candidates = sectionsIndex.get(pageNumber) || [];
      for (const c of candidates) {
        // Skip near-empty/low-signal detections rather than cluttering the
        // review queue — tune this threshold against your real layouts.
        if (!c.headline || c.headline.trim().length < 4) continue;
        await createDraftStory({
          pageDocumentId: page.documentId,
          box: c.box,
          headline: c.headline.trim(),
          teaser: c.teaser,
          body: c.body,
          detectionConfidence: c.detectionConfidence
        });
        createdStoryCount += 1;
      }
    }

    await updateEditionStatus(editionDocumentId, {
      pageCount: imagePaths.length,
      pipelineStatus: 'ready_for_review',
      pipelineError: null
    });

    return { editionDocumentId, pages: imagePaths.length, draftStoriesCreated: createdStoryCount };
  } catch (err) {
    await updateEditionStatus(editionDocumentId, {
      pipelineStatus: 'failed',
      pipelineError: String(err?.message || err)
    }).catch(() => {}); // best-effort — don't mask the original error if this also fails
    throw err;
  } finally {
    // Best-effort cleanup; leave artifacts in place if this fails, they're in /tmp.
    fs.promises.rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Allows `npm run ingest:cli -- <editionDocumentId>` for manual/local runs
// without going through the webhook.
if (import.meta.url === `file://${process.argv[1]}`) {
  const editionDocumentId = process.argv[2];
  if (!editionDocumentId) {
    console.error('Usage: node src/pipeline/runIngest.js <editionDocumentId>');
    process.exit(1);
  }
  runIngest(editionDocumentId)
    .then(result => { console.log('Ingest complete:', result); process.exit(0); })
    .catch(err => { console.error('Ingest failed:', err); process.exit(1); });
}
