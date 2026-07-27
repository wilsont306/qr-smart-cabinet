/**
 * Generate printable QR codes for all 9 cabinet drawers.
 *
 * Usage:
 *   npm run qr:generate
 *   APP_URL=https://your-host.example.com npm run qr:generate
 *
 * Branded (NYC FIRST logo in center — same URLs, separate output folder):
 *   npm run qr:generate:branded
 *   LOGO_PATH=public/brand/official-logo.png npm run qr:generate:branded
 *
 * Output:
 *   public/qrcodes/drawer-1.png … drawer-9.png (+ index.html)
 *   public/qrcodes/branded/… when branded
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

const DRAWERS = [
  { n: 1, shortCode: "A1-7Q4", label: "Drawer 1", item: "Cat6 Patch Cable 1m" },
  { n: 2, shortCode: "A2-3K9", label: "Drawer 2", item: "Cat6 Patch Cable 3m" },
  { n: 3, shortCode: "A3-8M2", label: "Drawer 3", item: "HDMI Cable" },
  { n: 4, shortCode: "A4-0X5", label: "Drawer 4", item: "USB-C Cable" },
  { n: 5, shortCode: "A5-2R1", label: "Drawer 5", item: "Power Cable" },
  { n: 6, shortCode: "A6-5T7", label: "Drawer 6", item: "Fiber Cable" },
  { n: 7, shortCode: "A7-9W3", label: "Drawer 7", item: "Cable Ties" },
  { n: 8, shortCode: "A8-1Y6", label: "Drawer 8", item: "Velcro Straps" },
  { n: 9, shortCode: "A9-4Z8", label: "Drawer 9", item: "RJ45 Connectors" },
];

const branded =
  process.env.BRANDED === "1" || process.argv.includes("--branded");
const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const outDir = branded
  ? path.join(rootDir, "public", "qrcodes", "branded")
  : path.join(rootDir, "public", "qrcodes");
const logoPath = process.env.LOGO_PATH
  ? path.resolve(rootDir, process.env.LOGO_PATH)
  : path.join(rootDir, "public", "brand", "nyc-first-logo.png");
const qrSize = Number(process.env.QR_SIZE || 512);

async function writePlainQr(filePath, url) {
  await QRCode.toFile(filePath, url, {
    type: "png",
    width: qrSize,
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#1C2B4A", light: "#FFFFFF" },
  });
}

/**
 * Same URL encoding as plain QRs; logo is visual only.
 * High error correction (H) keeps scans reliable with a small center cover.
 */

/**
 * Knock out the black field, keep the mark, add a soft white halo so QR
 * modules don't eat the edges — no rectangle / circle plate.
 */
async function prepareLogoMark(logoPath, maxSize) {
  const halo = Math.max(3, Math.round(maxSize * 0.045));

  const { data, info } = await sharp(logoPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const src = data;
  const mask = new Uint8Array(w * h);

  for (let i = 0, p = 0; i < src.length; i += info.channels, p++) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    mask[p] = lum > 22 ? 1 : 0;
  }

  const dilated = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -halo; dy <= halo; dy++) {
        for (let dx = -halo; dx <= halo; dx++) {
          if (dx * dx + dy * dy > halo * halo) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          dilated[ny * w + nx] = 1;
        }
      }
    }
  }

  const out = Buffer.alloc(w * h * 4);
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  let sx = 0;
  let sy = 0;
  let sw = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const o = p * 4;
      if (!dilated[p]) {
        out[o + 3] = 0;
        continue;
      }

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (mask[p]) {
        const i = p * info.channels;
        let r = src[i];
        let g = src[i + 1];
        let b = src[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        if (lum < 90 && sat < 35) {
          r = 20;
          g = 20;
          b = 20;
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = 255;
        const weight = Math.max(1, lum);
        sx += x * weight;
        sy += y * weight;
        sw += weight;
      } else {
        out[o] = 255;
        out[o + 1] = 255;
        out[o + 2] = 255;
        out[o + 3] = 255;
      }
    }
  }

  if (maxX < 0) {
    throw new Error("Logo has no visible ink to place on the QR.");
  }

  const cropped = await sharp(out, {
    raw: { width: w, height: h, channels: 4 },
  })
    .extract({
      left: minX,
      top: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    })
    .png()
    .toBuffer();

  const meta = await sharp(cropped).metadata();
  const tw = meta.width || maxSize;
  const th = meta.height || maxSize;
  const scale = Math.min(maxSize / tw, maxSize / th);
  const markW = Math.max(1, Math.round(tw * scale));
  const markH = Math.max(1, Math.round(th * scale));

  const resized = await sharp(cropped)
    .resize(markW, markH, { fit: "fill" })
    .png()
    .toBuffer();

  const cropCx = sw ? sx / sw - minX : tw / 2;
  const cropCy = sw ? sy / sw - minY : th / 2;

  return {
    buffer: resized,
    optical: {
      cx: cropCx * scale,
      cy: cropCy * scale,
      width: markW,
      height: markH,
    },
  };
}

async function writeBrandedQr(filePath, url, logo) {
  const qrBuffer = await QRCode.toBuffer(url, {
    type: "png",
    width: qrSize,
    margin: 2,
    errorCorrectionLevel: "H",
    color: { dark: "#1C2B4A", light: "#FFFFFF" },
  });

  const qrMeta = await sharp(qrBuffer).metadata();
  const width = qrMeta.width || qrSize;
  const height = qrMeta.height || qrSize;

  const maxMark = Math.round(Math.min(width, height) * 0.24);
  const { buffer: overlay, optical } = await prepareLogoMark(logo, maxMark);

  // Place so the artwork's optical center lands on the QR center.
  const left = Math.round(width / 2 - optical.cx);
  const top = Math.round(height / 2 - optical.cy);

  await sharp(qrBuffer)
    .composite([{ input: overlay, left, top }])
    .png()
    .toFile(filePath);
}

function buildPrintSheet(cards, titleSuffix) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Smart Cabinet — Drawer QR Codes${titleSuffix}</title>
  <style>
    @page { size: letter; margin: 0.5in; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Archivo, ui-sans-serif, system-ui, sans-serif;
      color: #1c2b4a;
      background: #f4f6f7;
    }
    header {
      padding: 24px 28px 8px;
    }
    header .eyebrow {
      color: #cf2233;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    header h1 {
      margin: 4px 0 0;
      font-size: 28px;
      font-weight: 800;
    }
    header p {
      margin: 8px 0 0;
      color: #4a5670;
      font-size: 14px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      padding: 16px 28px 28px;
    }
    .card {
      background: #fff;
      border: 1px solid #d8e0e2;
      border-radius: 16px;
      padding: 16px;
      text-align: center;
      page-break-inside: avoid;
    }
    .card img {
      width: 180px;
      height: 180px;
      image-rendering: pixelated;
    }
    .card h2 {
      margin: 10px 0 2px;
      font-size: 18px;
      font-weight: 800;
    }
    .card .item {
      color: #4a5670;
      font-size: 12px;
      margin: 0 0 6px;
    }
    .card .code {
      display: inline-block;
      margin-top: 4px;
      padding: 4px 10px;
      border-radius: 999px;
      background: #eef2f3;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.06em;
    }
    .card .url {
      margin-top: 8px;
      color: #6b7d7e;
      font-size: 9px;
      word-break: break-all;
    }
    @media print {
      body { background: #fff; }
      header p { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">NYC FIRST</div>
    <h1>Smart Cabinet QR Codes${titleSuffix}</h1>
    <p>Base URL: <strong>${base}</strong> — print and affix one sticker per drawer. Scan opens that drawer.</p>
  </header>
  <div class="grid">
    ${cards
      .map(
        (c) => `
    <article class="card">
      <img src="${c.file}" alt="QR for ${c.label}" />
      <h2>${c.label}</h2>
      <p class="item">${c.item}</p>
      <div class="code">${c.shortCode}</div>
      <div class="url">${c.url}</div>
    </article>`,
      )
      .join("")}
  </div>
</body>
</html>
`;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  if (branded && !fs.existsSync(logoPath)) {
    throw new Error(
      `Logo not found at ${logoPath}. Add a square PNG/SVG or set LOGO_PATH.`,
    );
  }

  const cards = [];
  for (const d of DRAWERS) {
    const url = `${base}/d/${encodeURIComponent(d.shortCode)}`;
    const file = `drawer-${d.n}.png`;
    const filePath = path.join(outDir, file);

    if (branded) {
      await writeBrandedQr(filePath, url, logoPath);
    } else {
      await writePlainQr(filePath, url);
    }

    console.log(`✓ ${d.label} → ${url}${branded ? " (branded)" : ""}`);
    cards.push({ ...d, url, file });
  }

  const relOut = path.relative(path.join(rootDir, "public"), outDir);
  fs.writeFileSync(
    path.join(outDir, "index.html"),
    buildPrintSheet(cards, branded ? " (Branded)" : ""),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        base,
        branded,
        logo: branded ? path.relative(rootDir, logoPath) : null,
        generatedAt: new Date().toISOString(),
        drawers: cards,
      },
      null,
      2,
    ),
  );

  console.log(`\nWrote ${cards.length} QR codes → public/${relOut}/`);
  console.log(`Print sheet → ${base}/${relOut}/index.html`);
  if (branded) {
    console.log(`Logo: ${path.relative(rootDir, logoPath)}`);
    console.log("Tip: test-scan one sticker before printing the full sheet.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
