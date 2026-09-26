/**
 * apps/ingest/scripts/seed-plans.mjs
 *
 * One-time seed for the epaper-plan collection — without this, EVERY
 * checkout attempt fails with "No active plan with key ...", since
 * epaper-transaction's initialize action looks up the plan by key and
 * 404s if nothing matches (exactly what was observed).
 *
 * PRICES BELOW ARE PLACEHOLDERS — matched to what was already being
 * displayed for single_archive (1,000 UGX, per the paywall screenshot
 * that prompted this) so this doesn't introduce a NEW mismatch against
 * config.pricing.archiveEdition, which the paywall's displayed price
 * still reads from (a known, separately-tracked gap — see editions.js's
 * priceFor()). Everything else here is a reasonable round-number guess,
 * not real pricing — edit the `price` values below before running this
 * against production.
 *
 * Safe to re-run — skips any key that's already registered rather than
 * creating a duplicate.
 *
 * Usage (from apps/ingest/):
 *   node scripts/seed-plans.mjs
 */
import 'dotenv/config';

const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1397';
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN;

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${STRAPI_API_TOKEN}`, ...extra };
}

// EDIT THESE to your real pricing before running in production.
const PLANS = [
  { key: 'daily', label: 'Daily Access', kind: 'daily', durationDays: null, price: 1000, allowsOrgPurchase: false, sortOrder: 0 },
  { key: 'single_archive', label: 'Single Archive Edition', kind: 'single_archive', durationDays: null, price: 1000, allowsOrgPurchase: false, sortOrder: 1 },
  { key: 'weekly', label: 'Weekly Subscription', kind: 'period_subscription', durationDays: 7, price: 5000, allowsOrgPurchase: true, sortOrder: 2 },
  { key: 'monthly', label: 'Monthly Subscription', kind: 'period_subscription', durationDays: 30, price: 15000, allowsOrgPurchase: true, sortOrder: 3 },
  { key: 'quarterly', label: 'Quarterly Subscription', kind: 'period_subscription', durationDays: 90, price: 40000, allowsOrgPurchase: true, sortOrder: 4 },
  { key: 'annual', label: 'Annual Subscription', kind: 'period_subscription', durationDays: 365, price: 140000, allowsOrgPurchase: true, sortOrder: 5 },
  { key: 'all_archive_access', label: 'Full Archive Access', kind: 'all_archive_access', durationDays: null, price: 100000, allowsOrgPurchase: true, sortOrder: 6 }
];

async function existingKeys() {
  const res = await fetch(`${STRAPI_URL}/api/epaper-plans?pagination[pageSize]=200`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch existing plans: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return new Set((json.data || []).map(p => p.key));
}

async function createPlan(plan) {
  const res = await fetch(`${STRAPI_URL}/api/epaper-plans`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ data: { ...plan, currency: 'UGX', active: true } })
  });
  if (!res.ok) throw new Error(`Failed to create "${plan.key}": ${res.status} ${await res.text()}`);
}

const already = await existingKeys();
let created = 0;
let skipped = 0;

for (const plan of PLANS) {
  if (already.has(plan.key)) {
    skipped += 1;
    continue;
  }
  await createPlan(plan);
  created += 1;
  console.log(`created: ${plan.key} (${plan.price} UGX)`);
}

console.log(`\nDone — ${created} created, ${skipped} already existed.`);
console.log('Remember: the prices above are placeholders — edit them in Strapi admin (or this script, then re-run) to your real pricing.');
