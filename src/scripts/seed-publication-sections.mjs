/**
 * apps/ingest/scripts/seed-publication-sections.mjs
 *
 * One-time seed for New Vision's canonical section list into
 * api::publication-section (publicationCode: 'NV'). Run once after the
 * content-type exists in Strapi; safe to re-run — skips any name that's
 * already registered for this publicationCode rather than creating a
 * duplicate.
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

const SECTIONS = [
  'Adverts', 'Beat', 'Business', 'Business Vision', 'CSI', 'Case Files', 'Classified',
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

async function createSection(name, sortOrder) {
  const res = await fetch(`${STRAPI_URL}/api/publication-sections`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ data: { name, publicationCode: PUBLICATION_CODE, sortOrder } })
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
  await createSection(name, i);
  created += 1;
  console.log(`created: ${name}`);
}

console.log(`\nDone — ${created} created, ${skipped} already existed.`);
