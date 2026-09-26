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
 */
export async function getEdition(editionDocumentId) {
  const res = await fetch(
    `${STRAPI_URL}/api/editions/${editionDocumentId}?populate=sourcePdf&status=draft`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`getEdition ${editionDocumentId} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data; // flattened — e.g. json.data.date, json.data.sourcePdf.url
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

/** Create a Page document linking a page image to an edition (by documentId). */
export async function createPage({ editionDocumentId, pageNumber, section, imageId }) {
  const res = await fetch(`${STRAPI_URL}/api/pages`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      data: { edition: editionDocumentId, pageNumber, section, image: imageId }
    })
  });
  if (!res.ok) throw new Error(`createPage ${pageNumber} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data; // { documentId, pageNumber, ... }
}

/** Create a draft Story hotspot on a page (auto-detected — needs editor review before publish). */
export async function createDraftStory({ pageDocumentId, box, headline, teaser, body, detectionConfidence }) {
  const res = await fetch(`${STRAPI_URL}/api/stories?status=draft`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      data: {
        page: pageDocumentId,
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        headline,
        teaser,
        body,
        source: 'auto_detected',
        detectionConfidence
      }
    })
  });
  if (!res.ok) throw new Error(`createDraftStory failed: ${res.status} ${await res.text()}`);
  return (await res.json()).data;
}

/**
 * Update the edition's pipeline status (and pageCount / error message as
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
 * stories, per the documented publish workflow (set pipelineStatus, Save,
 * THEN click Strapi's own Publish button) — was left completely untouched:
 * still blank pageCount, still whatever pipelineStatus it had before ingest
 * ran. From the only vantage point that matters (the admin UI), it looked
 * like this function was doing nothing at all.
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