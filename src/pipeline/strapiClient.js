/**
 * File:      /var/www/VGEpaper/apps/ingest/src/pipeline/strapiClient.js
 * Repo path: apps/ingest/src/pipeline/strapiClient.js
 * System:    apps/ingest (Express, port 4158)          MODIFIED
 *
 * Changes: createPage/updatePage carry extractionStatus + extractionLedger;
 * createStory stores layout + reviewState; new findPageForEdition,
 * listPageStories, deleteStory for re-ingest that keeps manual stories.
 */
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'node:fs';

const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1397';
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN;

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${STRAPI_API_TOKEN}`, ...extra };
}

/**
 * Strapi 5's REST API is flattened compared to v4 — no more `data.attributes.x`,
 * just `data.x` directly — and every document is addressed by its `documentId`
 * (a string) rather than the legacy numeric `id`, both in mutation URLs and when
 * relating documents to each other. See: https://docs.strapi.io/cms/api/rest
 */

/**
 * Fetch an Edition document by its documentId, populated with sourcePdf.
 * `status=draft` is required here — the whole point of the ingest pipeline
 * is to run against an Edition BEFORE an editor has published it (that's
 * step 5 of the workflow, after reviewing the auto-detected stories), so
 * this is, by design, almost always still a draft document when ingest
 * reads it. Strapi 5's REST API only returns published entries by default;
 * without this param, a perfectly real draft Edition 404s.
 *
 * The returned object includes `sku` (auto-generated on the Edition itself
 * at creation — see apps/cms/src/api/edition/content-types/edition/
 * lifecycles.js) — runIngest.js reads it and passes it down to every Page
 * and Story this run creates, denormalized, so each can be identified
 * without traversing the edition relation.
 */
export async function getEdition(editionDocumentId) {
  const res = await fetch(
    `${STRAPI_URL}/api/editions/${editionDocumentId}?populate=sourcePdf&status=draft`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`getEdition ${editionDocumentId} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data; // flattened — e.g. json.data.date, json.data.sku, json.data.sourcePdf.url
}

/**
 * Known section names for ONE publication (api::publication-section,
 * scoped by publicationCode) — passed to extractSections() so its section
 * detection can recognize this specific paper's own vocabulary, not a
 * single list shared across every publication on the platform. Returns
 * [] (not a throw) if the fetch fails or nothing is registered yet —
 * extractSections() already handles an empty/missing known-sections list
 * gracefully, falling back to whatever text it actually detects rather
 * than requiring a match.
 */
export async function getPublicationSections(publicationCode) {
  try {
    const res = await fetch(
      `${STRAPI_URL}/api/publication-sections?filters[publicationCode][$eq]=${encodeURIComponent(publicationCode)}&sort=sortOrder:asc&pagination[pageSize]=200`,
      { headers: authHeaders() }
    );
    if (!res.ok) {
      console.warn(`[strapiClient] getPublicationSections(${publicationCode}) failed: ${res.status} — falling back to extractSections()'s own default list`);
      return [];
    }
    const json = await res.json();
    return (json.data || []).map(s => s.name).filter(Boolean);
  } catch (err) {
    console.warn(`[strapiClient] getPublicationSections(${publicationCode}) could not reach Strapi — falling back to extractSections()'s own default list:`, err.message);
    return [];
  }
}

/**
 * Section names (lowercased, as a Set) for which story extraction should
 * be skipped entirely — classified ads, advertorials, puzzle/leisure
 * pages, exam result listings, anything structurally not editorial
 * content. Growable over time through Strapi admin (flip
 * skipStoryExtraction on a publication-section entry) rather than a code
 * change. Returns an empty Set (not a throw) on any failure — a page
 * simply gets normal extraction attempted rather than the whole run
 * failing over a lookup that's meant to be a refinement, not a
 * dependency.
 */
export async function getSkipExtractionSections(publicationCode) {
  try {
    const res = await fetch(
      `${STRAPI_URL}/api/publication-sections?filters[publicationCode][$eq]=${encodeURIComponent(publicationCode)}&filters[skipStoryExtraction][$eq]=true&pagination[pageSize]=200`,
      { headers: authHeaders() }
    );
    if (!res.ok) {
      console.warn(`[strapiClient] getSkipExtractionSections(${publicationCode}) failed: ${res.status} — no sections will be skipped this run`);
      return new Set();
    }
    const json = await res.json();
    return new Set((json.data || []).map(s => (s.name || '').toLowerCase()).filter(Boolean));
  } catch (err) {
    console.warn(`[strapiClient] getSkipExtractionSections(${publicationCode}) could not reach Strapi — no sections will be skipped this run:`, err.message);
    return new Set();
  }
}

/** Download the edition's source PDF to a local path. */
export async function downloadSourcePdf(edition, destPath) {
  const pdfUrl = edition.sourcePdf?.url;
  if (!pdfUrl) throw new Error(`Edition ${edition.documentId} has no sourcePdf`);
  const fullUrl = pdfUrl.startsWith('http') ? pdfUrl : `${STRAPI_URL}${pdfUrl}`;
  const res = await fetch(fullUrl, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to download PDF: ${res.status}`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.body.pipe(out);
    res.body.on('error', reject);
    out.on('finish', resolve);
  });
  return destPath;
}

/**
 * Upload a single page image file to Strapi's Upload plugin. Note: the Upload
 * plugin is unchanged from v4 and still returns/keys files by numeric `id`,
 * NOT documentId — that numeric id is what a Page's `image` field expects.
 */
export async function uploadImage(filePath, fileName) {
  const form = new FormData();
  form.append('files', fs.createReadStream(filePath), fileName);
  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: authHeaders(form.getHeaders()),
    body: form
  });
  if (!res.ok) throw new Error(`uploadImage ${fileName} failed: ${res.status} ${await res.text()}`);
  const [uploaded] = await res.json();
  return uploaded.id;
}

/**
 * Create a Page document linking a page image to an edition (by documentId).
 * `section` must be one of Page.section's enum values (see its schema) or
 * null — extractSections() already only returns a value when it confidently
 * matched the canonical list, so this is a direct pass-through, not a
 * separate validation step.
 */
export async function createPage({ editionDocumentId, editionSku, pageNumber, section, imageId, extractionStatus = null, extractionLedger = null }) {
  const res = await fetch(`${STRAPI_URL}/api/pages`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      data: { edition: editionDocumentId, editionSku, pageNumber, section, image: imageId, extractionStatus, extractionLedger }
    })
  });
  if (!res.ok) throw new Error(`createPage ${pageNumber} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data; // { documentId, pageNumber, ... }
}

/**
 * The existing Page for (edition, pageNumber), newest first, or null.
 * Re-ingest reuses it instead of creating a second copy of every page —
 * duplicates would leave readers and editors looking at different pages.
 * Page has draftAndPublish off, so no status param is needed.
 */
export async function findPageForEdition(editionDocumentId, pageNumber) {
  const res = await fetch(
    `${STRAPI_URL}/api/pages?filters[edition][documentId][$eq]=${encodeURIComponent(editionDocumentId)}` +
    `&filters[pageNumber][$eq]=${Number(pageNumber)}&sort=createdAt:desc&pagination[pageSize]=1`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`findPageForEdition ${pageNumber} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).data?.[0] || null;
}

/** Update an existing Page (by documentId). */
export async function updatePage(pageDocumentId, data) {
  const res = await fetch(`${STRAPI_URL}/api/pages/${pageDocumentId}`, {
    method: 'PUT',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ data })
  });
  if (!res.ok) throw new Error(`updatePage ${pageDocumentId} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).data;
}

/** Every story on a page: documentId, source and reviewState only. */
export async function listPageStories(pageDocumentId) {
  const res = await fetch(
    `${STRAPI_URL}/api/stories?filters[page][documentId][$eq]=${encodeURIComponent(pageDocumentId)}` +
    `&fields[0]=source&fields[1]=reviewState&pagination[pageSize]=200`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`listPageStories ${pageDocumentId} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).data || [];
}

/** Delete a story document (all versions). */
export async function deleteStory(storyDocumentId) {
  const res = await fetch(`${STRAPI_URL}/api/stories/${storyDocumentId}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok && res.status !== 404) throw new Error(`deleteStory ${storyDocumentId} failed: ${res.status} ${await res.text()}`);
}

/**
 * Create a draft Story hotspot on a page (auto-detected — needs editor
 * review before publish). continuesToPage/continuesFromPage are only ever
 * set when extractSections() found an explicit jump-line marker in the
 * text ("Turned to Page N" / "Continued from Page N") — see that module's
 * own comments for why an absent marker is left null rather than guessed.
 */
/**
 * Create a Story hotspot on a page, published immediately — NOT created
 * as a draft awaiting editor review. This is a deliberate reversal of this
 * pipeline's original design (every detection reviewed before going live);
 * see the request that changed it if the tradeoff ever needs revisiting —
 * auto-detection's known limitations (occasional garbled/truncated
 * headlines even after defensive truncation, ad content sometimes
 * misdetected as a story, pull-quote text sometimes dropped) now reach
 * readers immediately, with nothing catching them first.
 * continuesToPage/continuesFromPage are only ever set when
 * extractSections() found an explicit jump-line marker in the text
 * ("Turned to Page N" / "Continued from Page N") — see that module's own
 * comments for why an absent marker is left null rather than guessed.
 */
export async function createStory({
  pageDocumentId, editionSku, box, regions, layout = null, kicker, headline, byline, teaser, body,
  detectionConfidence, continuesToPage, continuesFromPage
}) {
  const res = await fetch(`${STRAPI_URL}/api/stories?status=published`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      data: {
        page: pageDocumentId,
        editionSku,
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        regions,
        layout,
        reviewState: 'active',
        kicker,
        headline,
        byline,
        teaser,
        body,
        source: 'auto_detected',
        detectionConfidence,
        continuesToPage,
        continuesFromPage
      }
    })
  });
  if (!res.ok) throw new Error(`createStory failed: ${res.status} ${await res.text()}`);
  return (await res.json()).data;
}

/** Update the edition's pipeline status (and pageCount / error message as
 * relevant).
 *
 * `?status=draft` here is NOT optional — it's the actual fix for
 * "pageCount/pipelineStatus never seem to update after ingest." Strapi 5's
 * REST API defaults an update with NO status param to PUBLISH the document
 * immediately (this is documented Strapi 5 behavior, the opposite of what
 * you'd guess: "The Document Service API defaults to draft, but the REST
 * API defaults to published" — https://docs.strapi.io/cms/api/rest/status).
 * Without this param, this PUT was silently creating/updating a PUBLISHED
 * copy of the edition that no one was looking at, while the actual DRAFT —
 * the one an editor sees in Strapi admin while reviewing auto-detected
 * stories — was left completely untouched.
 */
export async function updateEditionStatus(editionDocumentId, data) {
  const res = await fetch(`${STRAPI_URL}/api/editions/${editionDocumentId}?status=draft`, {
    method: 'PUT',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ data })
  });
  if (!res.ok) throw new Error(`updateEditionStatus failed: ${res.status} ${await res.text()}`);
  return (await res.json()).data;
}