/**
 * apps/ingest/scripts/seed-publication-sections.mjs
 *
 * One-time seed for New Vision's canonical section list into
 * api::publication-section (publicationCode: 'NV'), including which
 * sections should skip story extraction entirely (skipStoryExtraction) —
 * sections that are structurally not editorial content (classified ads,
 * advertorials, puzzle/leisure pages, exam result listings) rather than
 * something the extraction heuristic is expected to parse. Growable over
 * time via Strapi admin — this script only establishes the starting list.
 *
 * Run once after the content-type exists in Strapi; safe to re-run —
 * skips any name already registered for this publicationCode rather than
 * creating a duplicate, and does NOT touch skipStoryExtraction on an
 * existing entry (so a manual change in Strapi admin isn't silently
 * reverted by re-running this).
 *
 * Usage (from apps/ingest/):
 *   node scripts/seed-publication-sections.mjs
 *
 * Reads STRAPI_URL / STRAPI_API_TOKEN from .env, same as the rest of this
 * service.
 */
import 'dotenv/config';

const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1397';
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN;
const PUBLICATION_CODE = 'NV';

// Sections that skip story extraction entirely — the page image still
// gets created and is viewable, just with no Story candidates attempted.
const SKIP_EXTRACTION = new Set([
  'Crocs', 'Adverts', 'Advert', 'Advertorial', 'Leisure', 'PLE', 'OLEVEL', 'ALEVEL'
]);

const SECTIONS = [
  'Adverts', 'Advert', 'Advertorial', 'Beat', 'Business', 'Business Vision', 'CSI', 'Case Files', 'Classified',
  'Comments', 'Community News', 'Court', 'Crocs', 'Election News', 'Feature', 'Green UG',
  'Harvest Money', 'Health', 'Her Vision', 'Homes', 'International News', 'JobMart',
  'Leisure', 'Letters', 'Lifestyle', 'Motor Mart', 'Mwalimu', 'NIE', 'National News',
  'New Era', 'News', 'OPED', 'Oil, Gas and Infrastructure', 'Opportunities', 'PLE',
  'OLEVEL', 'ALEVEL', 'Pakasa', 'Relationships', 'Schools', 'Series', 'Special Report',
  'Sport', 'Spotlight', 'Supplements', 'Teen Vision', 'TV and Leisure', 'The Hot Sport',
  'Weekend Xtra', 'Muslim News', 'Back Cover Page'
];

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${STRAPI_API_TOKEN}`, ...extra };
}

async function existingNames() {
  const res = await fetch(
    `${STRAPI_URL}/api/publication-sections?filters[publicationCode][$eq]=${PUBLICATION_CODE}&pagination[pageSize]=200`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`Failed to fetch existing sections: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return new Set((json.data || []).map(s => s.name));
}

async function createSection(name, sortOrder, skipStoryExtraction) {
  const res = await fetch(`${STRAPI_URL}/api/publication-sections`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ data: { name, publicationCode: PUBLICATION_CODE, sortOrder, skipStoryExtraction } })
  });
  if (!res.ok) throw new Error(`Failed to create "${name}": ${res.status} ${await res.text()}`);
}

const already = await existingNames();
let created = 0;
let skipped = 0;

for (let i = 0; i < SECTIONS.length; i++) {
  const name = SECTIONS[i];
  if (already.has(name)) {
    skipped += 1;
    continue;
  }
  const skipExtraction = SKIP_EXTRACTION.has(name);
  await createSection(name, i, skipExtraction);
  created += 1;
  console.log(`created: ${name}${skipExtraction ? ' (skips story extraction)' : ''}`);
}

console.log(`\nDone — ${created} created, ${skipped} already existed.`);
if (skipped > 0) {
  console.log('Sections that already existed were NOT updated — if you need to flip skipStoryExtraction on one of those, do it directly in Strapi admin.');
}
