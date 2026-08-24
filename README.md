# Ingest service

Converts the PDF an editor uploaded to Strapi (`Edition.sourcePdf`) into:

1. **Page images** — one per PDF page, uploaded to Strapi's media library and
   linked as `Page` entries under that `Edition`.
2. **Candidate story hotspots** — regions detected from the PDF's text layout
   (headline-sized text + the body that follows it), created as **draft**
   `Story` entries with `source: "auto_detected"`.

## Why detection isn't "done" automatically

Font-size-based headline detection is a real, working heuristic — not a stub —
but it's still a heuristic. It will get confused by pull quotes, multi-deck
headlines, and unusual page designs. That's a fundamental limit of inferring
structure from a flattened PDF rather than from original layout data, not a
gap in this scaffold specifically. So every detected box lands as a **draft**:
an editor opens the Edition in Strapi, reviews each auto-detected Story
(headline text, byline, teaser, and the box position/size), corrects anything
wrong, and publishes it. Only published Stories are ever served to readers.

## System dependency

This uses poppler's CLI tools (`pdftoppm`, `pdftotext`) rather than a pure-JS
PDF library, for rendering fidelity on real print PDFs. Install it wherever
this service runs:

```bash
# Debian/Ubuntu
apt-get install -y poppler-utils

# macOS
brew install poppler
```

## How it's triggered

`apps/cms/.../edition/lifecycles.js` calls `POST /ingest/edition/:id` on this
service whenever an Edition's `sourcePdf` is set or changed. This service pulls
the PDF itself via the Strapi API (using `STRAPI_API_TOKEN`) rather than
receiving the file in the webhook body, so large PDFs don't need to round-trip
through the webhook payload.

## Running

```bash
cp .env.example .env   # fill in STRAPI_API_TOKEN and INGEST_WEBHOOK_SECRET
npm install
npm run dev             # http://localhost:4158
```

Manual one-off run without the webhook (useful while testing):

```bash
npm run ingest:cli -- <editionId>
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/ingest/edition/:id` | Trigger the pipeline for an edition (called by Strapi's lifecycle hook) |
| GET | `/ingest/edition/:id/status` | Check progress of the most recent run for that edition |
| GET | `/healthz` | Liveness check |
