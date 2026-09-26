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

## System dependencies

Two separate tools this service shells out to, rather than reimplementing PDF
parsing in JS — poppler for text/rasterization, Python for box/image-region
detection. Both need to be present wherever this service runs.

### poppler (`pdftoppm`, `pdftotext`)

Used for rendering fidelity on real print PDFs, over a pure-JS PDF library.

```bash
# Debian/Ubuntu
apt-get install -y poppler-utils

# macOS
brew install poppler
```

### Python + pdfplumber (`scripts/detect_boxes.py`)

Detects visual "container" rectangles (tinted sidebars, bordered call-out
boxes) and image positions on each page — this is what stops a headline
sitting next to an unrelated sidebar box from being merged into one garbled
block. `pdfplumber` is Python; there's no equivalent JS library with this
level of maturity for reading a PDF's actual vector graphics, so this one
piece shells out rather than being pure Node like the rest of the pipeline.

**This is an enhancement, not a hard requirement** — if it's not set up,
`extractSections.js` logs a warning and continues with reduced accuracy
(sidebar-box pages are more likely to merge incorrectly) rather than failing
the whole run. Worth setting up properly regardless, not something to skip
long-term.

**Setup (Ubuntu 24.04+, run inside `apps/ingest/`):**

```bash
apt install python3-pip python3.12-venv -y
python3 -m venv venv
./venv/bin/pip install pdfplumber
```

Confirm it actually worked before moving on:

```bash
./venv/bin/python3 -c "import pdfplumber; print(pdfplumber.__version__)"
```

That should print a version number with no errors. `extractSections.js`
automatically looks for `venv/bin/python3` first (`venv\Scripts\python.exe`
on Windows) and only falls back to a bare `python3`/`python` command if no
venv is present — no config needed once the venv exists at this path.

A **virtual environment**, not a system-wide `pip install`, is deliberate:
Ubuntu 24.04+ blocks `pip install` from touching system Python directly
(PEP 668 — the "externally managed environment" error), specifically to
prevent conflicts with apt-managed packages. A venv sidesteps that
protection entirely rather than overriding it. If `pip install
pdfplumber --break-system-packages` was used instead on some setup, that
still works fine too — the fallback above still finds and uses it.

**If `apt install` fails with `Cannot initiate the connection to
<region>.archive.ubuntu.com` / `Network is unreachable`:** the regional
Ubuntu mirror in `/etc/apt/sources.list.d/ubuntu.sources` (or
`/etc/apt/sources.list` on older Ubuntu releases) may simply be down —
this isn't specific to this package, anything from that mirror will fail
the same way. Point apt at the global default mirror instead:

```bash
sudo sed -i 's|<region>.archive.ubuntu.com|archive.ubuntu.com|g' /etc/apt/sources.list.d/ubuntu.sources
apt update
apt --fix-broken install -y   # if a previous attempt left python3-pip half-configured
```

**If `python3 -m venv venv` fails with `ensurepip is not available`:**
`python3.12-venv` (or whichever version matches `python3 --version`) is a
separate apt package from `python3-pip` itself — install it, then retry:

```bash
apt install python3.12-venv -y
rm -rf venv   # remove the half-created one first
python3 -m venv venv
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