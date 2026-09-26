import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import {
  getEdition, getPublicationSections, downloadSourcePdf, uploadImage, createPage, createDraftStory, updateEditionStatus
} from './strapiClient.js';
import { convertPdfToImages } from './convertPdfToImages.js';
import { extractSections, DEFAULT_PUBLICATION_SECTIONS } from './extractSections.js';

const WORK_DIR = process.env.WORK_DIR || '/tmp/newvision-ingest';
const DPI = Number(process.env.PAGE_IMAGE_DPI || 150);
const FORMAT = process.env.PAGE_IMAGE_FORMAT === 'png' ? 'png' : 'jpeg';

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * Full pipeline for one Edition, identified throughout by its Strapi 5
 * `documentId` (a string) — never the legacy numeric `id`:
 *   1. pull the sourcePdf Strapi is holding
 *   2. rasterize every page to an image (pdftoppm)
 *   3. extract layout-aware sections/stories from the PDF's real text
 *      layer (pdftotext -bbox + pdfplumber box/image detection) — see
 *      extractSections.js for the actual algorithm, validated directly
 *      against real New Vision issues, not just written to theory
 *   4. upload page images + create Page documents, each tagged with its
 *      detected section and the parent edition's SKU
 *   5. create the detected stories as *draft* Story documents for review,
 *      each also tagged with the edition SKU and any jump-line-derived
 *      cross-page continuation links
 *   6. flip the Edition to ready_for_review (or failed, with the error recorded)
 *
 * Scope is native-text PDFs only — no OCR/scanned-PDF path, no .indd.
 */
export async function runIngest(editionDocumentId) {
  const runDir = path.join(WORK_DIR, `edition-${editionDocumentId}-${Date.now()}`);
  await fs.promises.mkdir(runDir, { recursive: true });

  try {
    const edition = await getEdition(editionDocumentId);
    const dateLabel = edition.date; // flattened response — no .attributes wrapper in Strapi 5
    const editionSku = edition.sku; // auto-generated on the Edition itself — see its own lifecycles.js

    const pdfPath = path.join(runDir, 'source.pdf');
    await downloadSourcePdf(edition, pdfPath);

    const imagesDir = path.join(runDir, 'images');
    const imagePaths = await convertPdfToImages(pdfPath, imagesDir, { dpi: DPI, format: FORMAT });

    // Per-publication section vocabulary, not one global list — see
    // extractSections.js's detectSectionHeader() for why. Falls back to
    // the original New Vision list only when nothing's registered yet for
    // this publicationCode (a brand new, likely still-empty collection) —
    // getPublicationSections([]) would otherwise EXPLICITLY pass an empty
    // array through, which is not the same as omitting the argument:
    // extractSections()'s own default parameter only applies to
    // undefined, so an empty list here would silently disable even New
    // Vision's own clean matching until someone populates the new
    // publication-section collection through Strapi admin.
    const publicationCode = edition.publicationCode || 'NV';
    const fetchedSections = await getPublicationSections(publicationCode);
    const knownSections = fetchedSections.length ? fetchedSections : DEFAULT_PUBLICATION_SECTIONS;

    const pages = await extractSections(pdfPath, runDir, knownSections);
    const pagesByNumber = new Map(pages.map(p => [p.pageNumber, p]));

    let createdStoryCount = 0;
    for (let i = 0; i < imagePaths.length; i++) {
      const pageNumber = i + 1;
      const ext = FORMAT === 'png' ? 'png' : 'jpg';
      const fileName = `edition-${dateLabel}-pg-${pad2(pageNumber)}.${ext}`;

      try {
        const pageResult = pagesByNumber.get(pageNumber);
        const section = pageResult?.section || null;

        const imageId = await uploadImage(imagePaths[i], fileName);
        const page = await createPage({ editionDocumentId, editionSku, pageNumber, section, imageId });

        const candidates = pageResult?.candidates || [];
        for (const c of candidates) {
          // Skip near-empty/low-signal detections rather than cluttering the
          // review queue — tune this threshold against your real layouts.
          if (!c.headline || c.headline.trim().length < 4) continue;

          // Defensive truncation, not a substitute for fixing extraction
          // quality — Strapi's default string type caps at 255 characters,
          // and a genuinely garbled/merged headline can exceed that (seen
          // directly: a scrambled multi-column merge produced a 500+ char
          // "headline" that made Strapi reject the whole create call).
          // Truncating means a bad detection still lands as a reviewable
          // draft instead of being lost to a crash.
          const headline = c.headline.trim().slice(0, 252) + (c.headline.trim().length > 252 ? '…' : '');

          try {
            await createDraftStory({
              pageDocumentId: page.documentId,
              editionSku,
              box: c.box,
              kicker: c.kicker,
              headline,
              byline: c.byline,
              teaser: c.teaser,
              body: c.body,
              detectionConfidence: c.detectionConfidence,
              continuesToPage: c.continuesToPage,
              continuesFromPage: c.continuesFromPage
            });
            createdStoryCount += 1;
          } catch (err) {
            // ONE bad candidate must never abort the whole edition's ingest
            // — confirmed directly: a single 400 from Strapi (headline too
            // long) was propagating all the way up through this loop,
            // aborting the run after only 3 of 36+ pages. Log it and move
            // on to the next candidate; the editor reviewing drafts will
            // simply see one fewer hotspot on that page, not a failed
            // edition.
            console.error(`[runIngest] failed to create story on page ${pageNumber} ("${headline.slice(0, 60)}..."):`, err.message);
          }
        }
      } catch (err) {
        // Same reasoning one level up: a failure in uploadImage/createPage
        // itself — not just story creation — was found to ALSO abort the
        // whole run (confirmed directly: a run stopped after only 4 of a
        // much longer edition, with no story-creation error to explain
        // it — the failure was happening here instead, one level up from
        // where the first fix was applied). One page failing to upload or
        // create should cost that one page, not the rest of the edition.
        console.error(`[runIngest] failed to process page ${pageNumber}, skipping it:`, err.message);
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