/**
 * QR Smart Cabinet — Apps Script IMAGE helper only.
 *
 * Quantity / Is Locked / session tracker are written by the Next.js app via the
 * Google Sheets API (service account). This script only:
 *   - serves Image-column photos on Refresh (type: inventory + includePhotos)
 *   - hosts CellImage / floating images on Drive as =IMAGE(url)
 *   - answers ping / photo_probe for keepalive + debug
 *
 * Setup:
 *   1. Paste into Extensions → Apps Script (replace old Code.gs entirely).
 *   2. Script property SECRET = same as SHEETS_SECRET on Vercel.
 *   3. Run authorizeImageAccess once → Allow Drive + UrlFetch.
 *   4. Deploy → New version (Web app, Execute as Me, Anyone).
 *   5. SHEETS_WEBHOOK_URL = /exec URL on Vercel.
 *   6. Sheet menu: QR Cabinet → Connect images to app, then Refresh in the app.
 *
 * Inventory headers: Drawer | Part | Quantity | Is Locked | Image
 */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ error: 'no_body' });
    }
    var body = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || body.secret !== secret) {
      return json_({ error: 'forbidden' });
    }

    if (body.type === 'ping') {
      return json_({ ok: true, pong: true, ts: Date.now(), role: 'images' });
    }

    // Mutations moved to Sheets API — refuse so misconfigured clients fail loudly.
    if (
      body.type === 'set_quantity' ||
      body.type === 'set_locked' ||
      body.type === 'session_row' ||
      body.type === 'tx' ||
      body.type === 'lock_tx' ||
      body.type === 'snapshot'
    ) {
      return json_({
        ok: false,
        error: 'use_sheets_api',
        detail: 'Qty/lock/session writes belong on the Google Sheets API path.',
      });
    }

    if (body.type === 'inventory') {
      var table = locateTable_();
      // Light pulls (no photos) are optional fallback; Refresh sends includePhotos.
      var drawers = readInventory_({ includeHeavyPhotos: !!body.includePhotos });
      var withPhoto = 0;
      for (var di = 0; di < drawers.length; di++) {
        if (drawers[di].photo) withPhoto++;
      }
      return json_({
        ok: true,
        drawers: drawers,
        imageCol: table && table.col.image ? table.col.image : null,
        photos: withPhoto,
        heavy: !!body.includePhotos,
        role: 'images',
      });
    }

    if (body.type === 'photo_probe') {
      return json_(probePhotos_(body.number));
    }

    return json_({ error: 'unknown_type' });
  } catch (err) {
    return json_({ error: String(err) });
  }
}

function doGet() {
  var t = locateTable_();
  return json_({
    ok: true,
    role: 'images',
    sheet: t ? t.sheet.getName() : null,
    rows: t ? t.rows.length : 0,
    imageCol: t && t.col.image ? t.col.image : null,
  });
}

function parseDrawerNumber_(value) {
  if (typeof value === 'number' && isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  var m = String(value == null ? '' : value).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function parseQuantity_(value) {
  if (typeof value === 'number' && isFinite(value)) {
    return value < 0 ? 0 : Math.floor(value);
  }
  var m = String(value == null ? '' : value).replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (!m) return 0;
  var n = Number(m[0]);
  return isNaN(n) || n < 0 ? 0 : Math.floor(n);
}

function readInventory_(opts) {
  var t = locateTable_();
  if (!t) throw new Error('No sheet with a "Part" and "Quantity" header row found.');
  var includeHeavyPhotos = !!(opts && opts.includeHeavyPhotos);

  var drawers = [];
  for (var i = 0; i < t.rows.length; i++) {
    var row = t.rows[i];
    var number = t.col.drawer ? parseDrawerNumber_(row[t.col.drawer - 1]) : i + 1;
    if (!number) continue;
    var part = t.col.part ? String(row[t.col.part - 1] || '').trim() : '';
    var quantity = t.col.quantity ? parseQuantity_(row[t.col.quantity - 1]) : 0;
    var locked = true;
    if (t.col.locked) {
      var raw = row[t.col.locked - 1];
      if (typeof raw === 'boolean') locked = raw;
      else {
        var s = String(raw).trim().toLowerCase();
        locked = !(s === 'false' || s === '0' || s === 'no' || s === 'unlocked' || s === '');
      }
    }
    var sheetRow = t.headerRow + 1 + i;
    var entry = {
      number: number,
      part: part,
      quantity: quantity,
      locked: locked,
    };
    if (includeHeavyPhotos) {
      var photo = '';
      if (t.col.imageUrl) {
        photo = readCheapImageUrl_(String(row[t.col.imageUrl - 1] || '').trim());
      }
      if (!photo && t.col.image) {
        photo = readCellImageUrl_(t.sheet, sheetRow, t.col.image);
      }
      entry.photo = photo;
    }
    drawers.push(entry);
  }
  return drawers;
}


/** Fast path: formula / plain URL only — no Drive publish or CellImage fetch. */
function readCellImageUrlLight_(sheet, sheetRow, imageCol) {
  var range = sheet.getRange(sheetRow, imageCol);
  var formula = String(range.getFormula() || '');
  if (formula) {
    var m = formula.match(/^=\s*IMAGE\s*\(\s*["']([^"']+)["']/i);
    if (m && m[1]) return readCheapImageUrl_(m[1]);
  }
  var value = range.getValue();
  if (typeof value === 'string' && value.trim()) {
    return readCheapImageUrl_(value.trim());
  }
  return '';
}

function readCheapImageUrl_(raw) {
  if (!raw) return '';
  var s = String(raw).trim();
  if (!s) return '';
  if (/^data:image\//i.test(s)) return s;
  var driveId = extractDriveId_(s);
  if (driveId) return publicDriveImageUrl_(driveId);
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

/**
 * Resolve an Image cell to a URL the web app can show.
 * Supports:
 *   - Insert → Image → Image in cell (CellImage)
 *   - Insert → Image → Image over cells (floating OverGridImage)
 *   - =IMAGE("url"), https links, Drive file ids
 *
 * Large / in-cell images are hosted on Drive (anyone-with-link) so inventory
 * JSON stays small and phone photos are not silently dropped by size caps.
 */
function readCellImageUrl_(sheet, sheetRow, imageCol) {
  var detail = readCellImageDetail_(sheet, sheetRow, imageCol);
  return detail.url || '';
}

function readCellImageDetail_(sheet, sheetRow, imageCol) {
  var detail = {
    url: '',
    source: 'none',
    valueType: '',
    http: 0,
    bytes: 0,
    error: '',
  };
  var range = sheet.getRange(sheetRow, imageCol);
  var a1 = range.getA1Notation();
  var value = range.getValue();
  var formula = String(range.getFormula() || '');
  detail.valueType = value === null || value === ''
    ? 'empty'
    : typeof value === 'string'
      ? 'string'
      : String(value);

  var isCellImage =
    value &&
    (typeof value.getContentUrl === 'function' || String(value) === 'CellImage');

  // 1) Fresh Insert→Image CellImage (must win over a stale =IMAGE formula).
  if (isCellImage) {
    var fromCell = cellImageToHostedUrl_(value, sheet.getSheetId() + '!' + a1, detail);
    if (fromCell) {
      detail.url = fromCell;
      detail.source = 'cell';
      detail.error = '';
      persistImageFormula_(range, fromCell);
      return detail;
    }
    // CellImage is present but Google blocked getContentUrl — do NOT keep the
    // old =IMAGE(...) URL (that looks like "upload failed" / wrong photo).
    var fromOverlayWhileCell = findOverlayImageUrl_(sheet, sheetRow, imageCol, detail);
    if (fromOverlayWhileCell) {
      detail.url = fromOverlayWhileCell;
      detail.source = 'overlay';
      detail.error = '';
      persistImageFormula_(range, fromOverlayWhileCell);
      return detail;
    }
    detail.error =
      detail.error ||
      'cellimage_blocked_paste_https_url_or_use_image_over_cells';
    return detail;
  }

  // 2) Floating "Image over cells"
  var fromOverlay = findOverlayImageUrl_(sheet, sheetRow, imageCol, detail);
  if (fromOverlay) {
    detail.url = fromOverlay;
    detail.source = 'overlay';
    detail.error = '';
    persistImageFormula_(range, fromOverlay);
    return detail;
  }

  // 3) =IMAGE("url") or plain https / Drive link in the cell
  if (formula) {
    var m = formula.match(/^=\s*IMAGE\s*\(\s*["']([^"']+)["']/i);
    if (m && m[1]) {
      detail.url = resolveImageUrl_(m[1], detail);
      detail.source = detail.url ? 'formula' : 'none';
      if (!detail.url && !detail.error) detail.error = 'bad_formula_url';
      if (detail.url && detail.url.indexOf('http') === 0) {
        persistImageFormula_(range, detail.url);
      }
      return detail;
    }
  }

  if (typeof value === 'string' && value.trim()) {
    var asUrl = resolveImageUrl_(value.trim(), detail);
    if (asUrl) {
      detail.url = asUrl;
      detail.source = 'url';
      detail.error = '';
      if (asUrl.indexOf('http') === 0) persistImageFormula_(range, asUrl);
      return detail;
    }
  }

  if (!detail.error) detail.error = 'no_image';
  return detail;
}

/** Keep the sheet visual, give the app a stable URL on later pulls. */
function persistImageFormula_(range, url) {
  if (!range || !url || url.indexOf('http') !== 0) return;
  try {
    var safe = String(url).replace(/"/g, '');
    range.setFormula('=IMAGE("' + safe + '")');
  } catch (e) {
    // Non-fatal — inventory can still return the URL this request.
  }
}

/** Match a floating sheet image whose anchor sits on / near this Image cell. */
function findOverlayImageUrl_(sheet, sheetRow, imageCol, detail) {
  var images;
  try {
    images = sheet.getImages();
  } catch (e) {
    if (detail) detail.error = 'overlay_list:' + String(e);
    return '';
  }
  if (!images || !images.length) {
    if (detail && !detail.error) detail.error = 'no_overlay';
    return '';
  }

  var best = null;
  var bestScore = 999;
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    var anchor;
    try {
      anchor = img.getAnchorCell();
    } catch (e2) {
      continue;
    }
    if (!anchor) continue;
    var r = anchor.getRow();
    var c = anchor.getColumn();
    // Prefer Image-cell anchors; allow drift (float placement is imprecise).
    var rowDist = Math.abs(r - sheetRow);
    var colDist = Math.abs(c - imageCol);
    if (rowDist > 0 || colDist > 3) continue;
    var score = rowDist * 10 + colDist;
    if (score < bestScore) {
      bestScore = score;
      best = img;
    }
  }
  // Fallback: any floating image on this row.
  if (!best) {
    for (var j = 0; j < images.length; j++) {
      var img2 = images[j];
      var anchor2;
      try {
        anchor2 = img2.getAnchorCell();
      } catch (e3) {
        continue;
      }
      if (anchor2 && anchor2.getRow() === sheetRow) {
        best = img2;
        break;
      }
    }
  }
  if (!best) {
    if (detail && !detail.error) detail.error = 'overlay_miss_row_' + sheetRow;
    return '';
  }
  return overGridImageToHostedUrl_(best, sheet.getSheetId() + '!r' + sheetRow, detail);
}

function extractDriveId_(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  var m =
    s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/) ||
    s.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/) ||
    s.match(/\/d\/([a-zA-Z0-9_-]{20,})(?:\/|$)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{25,}$/.test(s)) return s;
  return '';
}

/** Browser-friendly Drive image URL (works in <img> when file is link-shared). */
function publicDriveImageUrl_(fileId) {
  return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1600';
}

/**
 * Turn any raw image reference into a URL the web app can load.
 * Drive links are opened as the script owner, shared "anyone with link",
 * and copied into the QR photo folder when needed.
 */
function resolveImageUrl_(raw, detail) {
  if (!raw) return '';
  var s = String(raw).trim();
  if (!s) return '';
  if (/^data:image\//i.test(s)) return s;

  var driveId = extractDriveId_(s);
  if (driveId) {
    var hosted = publishDriveFile_(driveId, detail);
    if (hosted) return hosted;
    return publicDriveImageUrl_(driveId);
  }

  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

function publishDriveFile_(fileId, detail) {
  var key = 'src:' + fileId;
  var cached = cachedDriveUrl_(key);
  if (cached) return cached;
  try {
    var file = DriveApp.getFileById(fileId);
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (shareErr) {
      // continue — copy may still work for the script owner
    }
    return hostImageBlob_(key, file.getBlob(), detail);
  } catch (e) {
    if (detail) detail.error = 'publish_drive:' + String(e);
    return '';
  }
}

function normalizeImageUrl_(raw) {
  return resolveImageUrl_(raw, null);
}

/**
 * CellImage → Drive-hosted view URL (or small data URL).
 * Content URLs require the script's OAuth token — plain UrlFetch gets 403.
 * Google sometimes throws on getContentUrl for in-cell images — we retry, then fail.
 */
function cellImageToHostedUrl_(cellImage, cacheKey, detail) {
  var contentUrl = '';
  var lastErr = '';
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      SpreadsheetApp.flush();
      if (attempt > 0) Utilities.sleep(400 * attempt);
      contentUrl = cellImage.getContentUrl();
      if (contentUrl) break;
    } catch (e) {
      lastErr = String(e);
      contentUrl = '';
    }
  }
  if (!contentUrl) {
    if (detail) {
      detail.error = lastErr
        ? 'getContentUrl:' + lastErr
        : 'empty_content_url';
    }
    return '';
  }

  var fingerprint = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, contentUrl)
  ).substring(0, 10);
  var key = cacheKey + ':' + fingerprint;

  var cached = cachedDriveUrl_(key);
  if (cached) return cached;

  var blob = fetchImageBlob_(contentUrl, detail);
  if (!blob) return '';
  return hostImageBlob_(key, blob, detail);
}

/** Floating OverGridImage → hosted URL via getBlob(). */
function overGridImageToHostedUrl_(img, cacheKey, detail) {
  try {
    if (typeof img.getUrl === 'function') {
      var linked = img.getUrl();
      if (linked) {
        var n = normalizeImageUrl_(linked);
        if (n) return n;
      }
    }
  } catch (e) {
    // continue to blob
  }
  try {
    var blob = img.getBlob();
    if (!blob) return '';
    var bytes = blob.getBytes() || [];
    var fingerprint = Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
    ).substring(0, 10);
    return hostImageBlob_(cacheKey + ':' + fingerprint, blob, detail);
  } catch (e2) {
    if (detail) detail.error = 'overlay_blob:' + String(e2);
    return '';
  }
}

function fetchImageBlob_(contentUrl, detail) {
  var resp = UrlFetchApp.fetch(contentUrl, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    },
  });
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
    resp = UrlFetchApp.fetch(contentUrl, {
      muteHttpExceptions: true,
      followRedirects: true,
    });
  }
  if (detail) detail.http = resp.getResponseCode();
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
    if (detail) detail.error = 'fetch_http_' + resp.getResponseCode();
    return null;
  }
  var blob = resp.getBlob();
  if (detail) detail.bytes = (blob.getBytes() || []).length;
  return blob;
}

/**
 * Prefer a stable Drive link so inventory JSON stays tiny.
 * Tiny images (<120KB) can stay as data URLs if Drive write fails.
 */
function hostImageBlob_(key, blob, detail) {
  if (!blob) return '';
  var bytes = blob.getBytes() || [];
  if (detail) detail.bytes = bytes.length;
  if (!bytes.length) {
    if (detail) detail.error = 'empty_blob';
    return '';
  }

  fixBlobMime_(blob, bytes);

  try {
    var url = putBlobOnDrive_(key, blob);
    if (url) return url;
  } catch (e) {
    if (detail) detail.error = 'drive:' + String(e);
  }

  // Fallback: inline only small images (phone photos are usually larger).
  if (bytes.length <= 120000) {
    var contentType = blob.getContentType() || 'image/jpeg';
    if (contentType.indexOf('image/') !== 0) contentType = 'image/jpeg';
    return 'data:' + contentType + ';base64,' + Utilities.base64Encode(bytes);
  }

  if (detail && !detail.error) {
    detail.error = 'too_large_no_drive_' + bytes.length;
  }
  return '';
}

function fixBlobMime_(blob, bytes) {
  var type = blob.getContentType() || '';
  if (type.indexOf('image/') === 0) return;
  // Signed byte sniff (Apps Script bytes are -128..127).
  if (bytes.length >= 3 && bytes[0] === -1 && bytes[1] === -40) {
    blob.setContentType('image/jpeg');
  } else if (
    bytes.length >= 8 &&
    bytes[0] === -119 &&
    bytes[1] === 80 &&
    bytes[2] === 78 &&
    bytes[3] === 71
  ) {
    blob.setContentType('image/png');
  } else if (
    bytes.length >= 6 &&
    bytes[0] === 71 &&
    bytes[1] === 73 &&
    bytes[2] === 70
  ) {
    blob.setContentType('image/gif');
  } else if (
    bytes.length >= 12 &&
    bytes[0] === 82 &&
    bytes[1] === 73 &&
    bytes[2] === 70 &&
    bytes[3] === 70
  ) {
    blob.setContentType('image/webp');
  } else {
    blob.setContentType('image/jpeg');
  }
}

function photoFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {
      // recreate below
    }
  }
  var folder = DriveApp.createFolder('QR Smart Cabinet Photos');
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

function cachedDriveUrl_(key) {
  var props = PropertiesService.getScriptProperties();
  var fileId = props.getProperty('img:' + key);
  if (!fileId) return '';
  try {
    DriveApp.getFileById(fileId);
    return publicDriveImageUrl_(fileId);
  } catch (e) {
    props.deleteProperty('img:' + key);
    return '';
  }
}

function putBlobOnDrive_(key, blob) {
  var props = PropertiesService.getScriptProperties();
  var folder = photoFolder_();
  var name = 'drawer-' + key.replace(/[^a-zA-Z0-9._-]+/g, '_').substring(0, 80);
  var file = folder.createFile(blob.setName(name));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  props.setProperty('img:' + key, file.getId());
  return publicDriveImageUrl_(file.getId());
}

/** Webhook + editor helper: why photos are / aren't resolving. */
function probePhotos_(number) {
  var t = locateTable_();
  if (!t) return { ok: false, error: 'no_table' };
  if (!t.col.image) {
    return {
      ok: false,
      error: 'no_image_column',
      headers: t.sheet.getRange(1, 1, 1, t.width).getValues()[0],
    };
  }
  var out = [];
  for (var i = 0; i < t.rows.length; i++) {
    var row = t.rows[i];
    var n = t.col.drawer ? parseDrawerNumber_(row[t.col.drawer - 1]) : i + 1;
    if (!n) continue;
    if (number != null && Number(number) && n !== Number(number)) continue;
    var sheetRow = t.headerRow + 1 + i;
    var detail = readCellImageDetail_(t.sheet, sheetRow, t.col.image);
    out.push({
      number: n,
      row: sheetRow,
      imageCol: t.col.image,
      source: detail.source,
      valueType: detail.valueType,
      http: detail.http,
      bytes: detail.bytes,
      hasUrl: Boolean(detail.url),
      urlPrefix: detail.url ? String(detail.url).substring(0, 48) : '',
      error: detail.error,
    });
  }
  return { ok: true, imageCol: t.col.image, drawers: out };
}

/** Run from Apps Script editor (Run → debugDrawerPhotos) to inspect Image cells. */
function debugDrawerPhotos() {
  var result = probePhotos_(null);
  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * Fast permission grant — run this first from the editor.
 * If Google asks, click Review permissions → Allow (Drive + external requests).
 */
function authorizeImageAccess() {
  // Touch each scope the Image column needs.
  UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
  var folder = photoFolder_();
  Logger.log('Authorized. Photo folder: ' + folder.getName() + ' (' + folder.getId() + ')');
}

/** Menu: convert Image-column cell/floating images into =IMAGE(url) for the app. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('QR Cabinet')
    .addItem('Authorize image access', 'authorizeImageAccess')
    .addItem('Connect images to app', 'publishImagesToApp')
    .addItem('Set image from URL (selected cell)', 'setImageFromUrlPrompt_')
    .addItem('Debug drawer photos', 'debugDrawerPhotos')
    .addToUi();
}

/**
 * Reliable path when Insert→Image in cell cannot be read by Apps Script:
 * paste any https / Drive link into the selected Image cell.
 */
function setImageFromUrlPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var range = SpreadsheetApp.getActiveRange();
  if (!range) {
    ui.alert('Select an Image cell first.');
    return;
  }
  var res = ui.prompt(
    'Set drawer image',
    'Paste an https image URL or Google Drive file link:',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var raw = String(res.getResponseText() || '').trim();
  if (!raw) {
    ui.alert('No URL entered.');
    return;
  }
  var detail = { error: '', bytes: 0, http: 0 };
  var url = resolveImageUrl_(raw, detail);
  if (!url || url.indexOf('http') !== 0) {
    ui.alert('Could not use that link. ' + (detail.error || 'Need a public https or Drive URL.'));
    return;
  }
  // Host a copy in the QR photo folder when possible (stable thumbnail URL).
  try {
    var driveId = extractDriveId_(url);
    if (driveId) {
      var hosted = publishDriveFile_(driveId, detail);
      if (hosted) url = hosted;
    } else {
      var blob = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true }).getBlob();
      if (blob && (blob.getBytes() || []).length) {
        var hosted2 = hostImageBlob_('url:' + Utilities.getUuid(), blob, detail);
        if (hosted2 && hosted2.indexOf('http') === 0) url = hosted2;
      }
    }
  } catch (e) {
    // keep original url
  }
  persistImageFormula_(range, url);
  ui.alert('Image set. Open the app and tap Refresh.');
}

/**
 * One-shot: host every Image-column picture on Drive and write =IMAGE("url")
 * into that cell so the web app can read it on Refresh.
 */
function publishImagesToApp() {
  var t = locateTable_();
  if (!t || !t.col.image) {
    SpreadsheetApp.getUi().alert('Add an Image column header (Image / Photo / Img) first.');
    return;
  }
  var linked = 0;
  var failed = 0;
  var notes = [];
  for (var i = 0; i < t.rows.length; i++) {
    var row = t.rows[i];
    var n = t.col.drawer ? parseDrawerNumber_(row[t.col.drawer - 1]) : i + 1;
    if (!n) continue;
    var sheetRow = t.headerRow + 1 + i;
    Logger.log('Drawer ' + n + '…');
    var detail = readCellImageDetail_(t.sheet, sheetRow, t.col.image);
    if (detail.url) {
      linked++;
      Logger.log('  ok source=' + detail.source + ' bytes=' + detail.bytes);
    } else {
      failed++;
      Logger.log('  fail valueType=' + detail.valueType + ' error=' + detail.error);
      if (String(detail.error || '').indexOf('cellimage_blocked') === 0 ||
          String(detail.error || '').indexOf('getContentUrl') === 0) {
        notes.push('Drawer ' + n + ': in-cell image blocked — use QR Cabinet → Set image from URL');
      }
    }
  }
  var msg =
    'Connected ' + linked + ' image(s).' +
    (failed ? ' ' + failed + ' row(s) had no readable image.' : '') +
    (notes.length ? '\n\n' + notes.join('\n') : '') +
    '\n\nThen open the app and tap Refresh.';
  Logger.log(msg);
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    // editor-only run
  }
}

function locateTable_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  // Prefer an inventory-looking tab when multiple Part/Quantity tables exist.
  sheets.sort(function (a, b) {
    return inventorySheetScore_(b.getName()) - inventorySheetScore_(a.getName());
  });

  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) continue;
    var width = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, width).getValues()[0];
    var col = {};
    for (var c = 0; c < headers.length; c++) {
      var h = String(headers[c] == null ? '' : headers[c]).trim().toLowerCase();
      if (h === 'drawer' || h === 'drawer #' || h === 'drawer number' || h === '# drawer') col.drawer = c + 1;
      else if ((h === '#' || h === 'no' || h === 'no.') && !col.drawer) col.drawer = c + 1;
      else if (h === 'part' || h === 'item' || h === 'parts' || h === 'item name') col.part = c + 1;
      else if (h === 'quantity' || h === 'qty' || h === 'stock' || h === 'count') col.quantity = c + 1;
      else if (h === 'is locked' || h === 'locked' || h === 'locked?') col.locked = c + 1;
      else if (h === 'image' || h === 'images' || h === 'photo' || h === 'photos' || h === 'img' || h === 'picture') col.image = c + 1;
      else if (h === 'photo url' || h === 'image url' || h === 'image link' || h === 'img url' || h === 'picture url') col.imageUrl = c + 1;
      else if (h === 'session id' || h === 'sessionid') col.sessionId = c + 1;
    }
    // Must be inventory (Part + Quantity), not the session tracker tab.
    if (col.part && col.quantity && !col.sessionId) {
      var lastRow = sheet.getLastRow();
      var numDataRows = Math.max(0, lastRow - 1);
      // Sheet.getRange(row, column, numRows, numColumns) — 3rd/4th are COUNTS.
      var rows = numDataRows > 0
        ? sheet.getRange(2, 1, numDataRows, width).getValues()
        : [];
      return { sheet: sheet, headerRow: 1, col: col, rows: rows, width: width };
    }
  }
  return null;
}

function inventorySheetScore_(name) {
  var n = String(name || '').toLowerCase();
  if (/inventory|stock|cabinet|drawer/.test(n)) return 10;
  if (/session|ledger|log|tracker|activity/.test(n)) return -10;
  return 0;
}

function findRowByNumber_(t, number) {
  if (!t.col.drawer) return -1;
  var target = Number(number);
  for (var i = 0; i < t.rows.length; i++) {
    if (parseDrawerNumber_(t.rows[i][t.col.drawer - 1]) === target) return i;
  }
  return -1;
}


function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.TEXT
  );
}
