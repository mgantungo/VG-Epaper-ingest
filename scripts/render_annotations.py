#!/usr/bin/env python3
"""
apps/ingest/scripts/render_annotations.py

Draws colored rectangles from an annotations JSON file onto a rasterized
page image. Called by visualize_extraction.mjs — not meant to be invoked
directly, though it works standalone if you already have both files.

Usage: python3 render_annotations.py <raster_image> <annotations_json> <output_png>

Requires: pip install Pillow (same venv as pdfplumber — see apps/ingest's
own README for setup).
"""
import sys
import json

def main():
    if len(sys.argv) != 4:
        print("Usage: render_annotations.py <raster_image> <annotations_json> <output_png>", file=sys.stderr)
        sys.exit(1)

    raster_path, data_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]

    from PIL import Image, ImageDraw, ImageFont

    with open(data_path) as f:
        data = json.load(f)

    img = Image.open(raster_path).convert('RGB')
    draw = ImageDraw.Draw(img, 'RGBA')

    # Scale factor: annotations are in PDF page-point coordinates;
    # the raster image is in pixels at whatever DPI it was rendered at.
    scale_x = img.width / data['pageWidth']
    scale_y = img.height / data['pageHeight']

    colors = {
        'green': (34, 197, 94),
        'blue': (59, 130, 246),
        'red': (239, 68, 68)
    }

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 13)
    except Exception:
        font = ImageFont.load_default()

    for ann in data['annotations']:
        color = colors.get(ann['color'], (128, 128, 128))
        x0, y0 = ann['x0'] * scale_x, ann['y0'] * scale_y
        x1, y1 = ann['x1'] * scale_x, ann['y1'] * scale_y

        # Semi-transparent fill + solid border, matching the reference
        # images' own highlighter-style markup.
        draw.rectangle([x0, y0, x1, y1], fill=color + (40,), outline=color + (255,), width=3)

        label = ann.get('label', '')
        if label:
            text_bbox = draw.textbbox((0, 0), label, font=font)
            text_w = text_bbox[2] - text_bbox[0]
            text_h = text_bbox[3] - text_bbox[1]
            label_y = max(0, y0 - text_h - 4)
            draw.rectangle([x0, label_y, x0 + text_w + 6, label_y + text_h + 4], fill=color + (220,))
            draw.text((x0 + 3, label_y + 1), label, fill=(255, 255, 255), font=font)

    img.save(output_path)
    print(f"Saved: {output_path} ({img.width}x{img.height})")

if __name__ == '__main__':
    main()