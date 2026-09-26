#!/usr/bin/env python3
"""
apps/ingest/scripts/detect_boxes.py

Detects visual "container" rectangles (tinted sidebars, bordered call-out
boxes) on one PDF page, and prints them as JSON to stdout.

Why this exists: extractSections.js needs to know when two nearby pieces of
text belong to different visual containers (e.g. a page's main headline
sitting right beside an unrelated sidebar box) so it never merges them —
but the actual GAP between them is often geometrically small and
indistinguishable from normal word-spacing at large font sizes (confirmed
directly against a real page: a headline and an adjacent sidebar box's
heading were only ~17pt apart, well within normal word-spacing range for
that font size). The reliable signal isn't distance, it's structure: is
there a detected filled or bordered rectangle around one but not the other.

Requires: pip install pdfplumber
Usage: python3 detect_boxes.py <pdf_path> <page_number_1_indexed>
Output: JSON {boxes: [...], images: [...]}, each entry {x0, y0, x1, y1} in
        PDF points, top-down coordinate system (matches pdftotext -bbox).
        images powers caption detection — a small text block sitting
        immediately below an image, roughly matching its width, is very
        likely that image's caption rather than a headline/body block.

Rectangles under 30x30pt are dropped — these are typically thin rule lines
or underlines, not real containers a story needs to respect as a boundary.
"""
import sys
import json

def main():
    if len(sys.argv) != 3:
        print("Usage: detect_boxes.py <pdf_path> <page_number_1_indexed>", file=sys.stderr)
        sys.exit(1)

    pdf_path, page_num = sys.argv[1], int(sys.argv[2])

    import pdfplumber
    with pdfplumber.open(pdf_path) as pdf:
        if page_num < 1 or page_num > len(pdf.pages):
            print(f"Page {page_num} out of range (PDF has {len(pdf.pages)} pages)", file=sys.stderr)
            sys.exit(1)
        page = pdf.pages[page_num - 1]

        boxes = []
        for r in page.rects:
            if not (r.get('fill') or r.get('stroke')):
                continue
            w, h = r['x1'] - r['x0'], r['bottom'] - r['top']
            if w < 30 or h < 30:
                continue
            boxes.append({'x0': r['x0'], 'y0': r['top'], 'x1': r['x1'], 'y1': r['bottom']})

        images = [
            {'x0': im['x0'], 'y0': im['top'], 'x1': im['x1'], 'y1': im['bottom']}
            for im in page.images
        ]

    print(json.dumps({'boxes': boxes, 'images': images}))

if __name__ == '__main__':
    main()