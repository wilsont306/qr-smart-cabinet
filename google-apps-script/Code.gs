/**
 * QR Smart Cabinet — Google Sheets inventory (sheet is source of truth).
 *
 * Paste this into your spreadsheet's Apps Script (Extensions → Apps Script),
 * set a Script Property named SECRET, then deploy as a Web App
 * (Execute as: Me · Who has access: Anyone). Put the /exec URL in
 * SHEETS_WEBHOOK_URL and the same secret in SHEETS_SECRET on the app side.
 *
 * Image column needs ONE authorization pass (UrlFetch + Drive):
 *   1. Also paste appsscript.json (Project Settings → Show "appsscript.json").
 *   2. In the editor, select publishImagesToApp → Run → Review permissions → Allow.
 *   3. Deploy → Manage deployments → Edit → New version → Deploy.
 *   4. In the app, tap Refresh — drawer photos come from the Image column.
 *
 * Inventory sheet (one row per drawer) — owned in Sheets:
 *     Drawer | Part | Quantity | Is Locked | Image
 *
 * Image column: Insert → Image → Image in cell (example 2), or =IMAGE("url"),
 * or a plain https / Drive link. The app shows that photo on the drawer.
 *
 * Session tracker sheet (append-only from the app):
 *     Name | Team # | Robotics Level | Time | Session ID | Action | Part | Quantity | Locked? | Shelf
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
    if (body.type === 'snapshot') {
      // Disabled — inventory Part / Quantity / Locked are owned by the sheet.
      // Use set_quantity for take/return stock updates only.
      return json_({ ok: false, error: 'snapshot_disabled' });
    }
    if (body.type === 'ping') {
      return json_({ ok: true, pong: true, ts: Date.now() });
    }
    if (body.type === 'inventory') {
      var table = locateTable_();
      // Default: light pull (qty/part/locked only — fastest).
      // includePhotos: true reads Image column (Refresh / sync).
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
      });
    }
    // Diagnostics for Image column — no base64 in response.
    if (body.type === 'photo_probe') {
      return json_(probePhotos_(body.number));
    }

    // Mutations share a document lock so rapid unlock/take/lock can't race cells.
    if (body.type === 'set_quantity') {
      return json_(withDocLock_(function () {
        return {
          ok: true,
          updated: setQuantity_(body.number, body.quantity),
        };
      }));
    }
    if (body.type === 'set_locked') {
      return json_(withDocLock_(function () {
        return {
          ok: true,
          updated: setLocked_(body.number, body.locked),
        };
      }));
    }
    if (body.type === 'session_row') {
      return json_(withDocLock_(function () {
        var row = body.row || {};
        if (body.action === 'update') {
          return { ok: true, updated: updateSessionRow_(row) };
        }
        return { ok: true, appended: appendSessionRow_(row) };
      }));
    }
    // Combined take/return: patch Quantity + write the session row in one call.
    if (body.type === 'tx') {
      return json_(withDocLock_(function () {
        var out = { ok: true };
        if (body.number != null && body.quantity != null) {
          out.qtyUpdated = setQuantity_(body.number, body.quantity);
        }
        if (body.row) {
          out.sessionUpdated = body.action === 'update'
            ? updateSessionRow_(body.row)
            : appendSessionRow_(body.row);
        }
        return out;
      }));
    }
    // Combined lock/unlock: patch Is Locked + write the session row in one call.
    if (body.type === 'lock_tx') {
      return json_(withDocLock_(function () {
        var lockOut = { ok: true };
        if (body.number != null && body.locked != null) {
          lockOut.lockUpdated = setLocked_(body.number, body.locked);
        }
        if (body.row) {
          lockOut.sessionUpdated = body.action === 'update'
            ? updateSessionRow_(body.row)
            : appendSessionRow_(body.row);
        }
        return lockOut;
      }));
    }
    return json_({ error: 'unknown_type' });
  } catch (err) {
    return json_({ error: String(err) });
  }
}

/** Serialize spreadsheet mutations across concurrent Web App executions. */
function withDocLock_(fn) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    throw new Error('sheet_busy');
  }
  try {
    var result = fn();
    // Flush before release so the next execution sees committed cells.
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  var t = locateTable_();
  return json_({
    ok: true,
    sheet: t ? t.sheet.getName() : null,
    rows: t ? t.rows.length : 0,
    drawers: t ? readInventory_() : [],
  });
}

/** Accepts 1, "1", "Drawer 1", "1.0", etc. */
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
    // Light pulls skip Image entirely (big speed win). Photos load on Refresh.
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
  var formula = String(range.getFormula() || '');
  if (formula) {
    var m = formula.match(/^=\s*IMAGE\s*\(\s*["']([^"']+)["']/i);
    if (m && m[1]) {
      detail.url = resolveImageUrl_(m[1], detail);
      detail.source = detail.url ? 'formula' : 'none';
      if (!detail.url && !detail.error) detail.error = 'bad_formula_url';
      // Rewrite to a browser-friendly Drive thumbnail URL when possible.
      if (detail.url && detail.url.indexOf('http') === 0) {
        persistImageFormula_(range, detail.url);
      }
      return detail;
    }
  }

  var value = range.getValue();
  detail.valueType = value === null || value === ''
    ? 'empty'
    : typeof value === 'string'
      ? 'string'
      : String(value);

  if (typeof value === 'string' && value.trim()) {
    var asUrl = resolveImageUrl_(value.trim(), detail);
    if (asUrl) {
      detail.url = asUrl;
      detail.source = 'url';
      return detail;
    }
  }

  // Insert → Image → Image in cell → CellImage object
  try {
    var isCellImage =
      value &&
      (typeof value.getContentUrl === 'function' || String(value) === 'CellImage');
    if (isCellImage && typeof value.getContentUrl === 'function') {
      var fromCell = cellImageToHostedUrl_(value, sheet.getSheetId() + '!' + a1, detail);
      if (fromCell) {
        detail.url = fromCell;
        detail.source = 'cell';
        persistImageFormula_(range, fromCell);
        return detail;
      }
    }
  } catch (e) {
    detail.error = 'cell:' + String(e);
  }

  // Floating images ("Image over cells") — same row, near Image column.
  var fromOverlay = findOverlayImageUrl_(sheet, sheetRow, imageCol, detail);
  if (fromOverlay) {
    detail.url = fromOverlay;
    detail.source = 'overlay';
    persistImageFormula_(range, fromOverlay);
    return detail;
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
 */
function cellImageToHostedUrl_(cellImage, cacheKey, detail) {
  var contentUrl = '';
  try {
    contentUrl = cellImage.getContentUrl();
  } catch (e) {
    if (detail) detail.error = 'getContentUrl:' + String(e);
    return '';
  }
  if (!contentUrl) {
    if (detail) detail.error = 'empty_content_url';
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
    .addItem('Debug drawer photos', 'debugDrawerPhotos')
    .addToUi();
}

/**
 * One-shot: host every Image-column picture on Drive and write =IMAGE("url")
 * into that cell so the web app can read it on Refresh.
 *
 * Tip: if the execution log spins forever, check the spreadsheet tab — alerts
 * open there, not in the script editor. Prefer Logger output below.
 */
function publishImagesToApp() {
  var t = locateTable_();
  if (!t || !t.col.image) {
    Logger.log('Add an Image column header (Image / Photo / Img) first.');
    return;
  }
  var linked = 0;
  var failed = 0;
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
    }
  }
  Logger.log(
    'Done. Connected ' + linked + ' image(s).' +
      (failed ? ' ' + failed + ' row(s) had no readable image.' : '') +
      ' Now open the app and tap Refresh.'
  );
}

/** Write only Quantity for one drawer. Never touches Part or Is Locked. */
function setQuantity_(number, quantity) {
  var t = locateTable_();
  if (!t) throw new Error('No sheet with a "Part" and "Quantity" header row found.');
  if (!t.col.quantity) throw new Error('No Quantity column found.');

  var rowIdx = findRowByNumber_(t, number);
  if (rowIdx === -1) return 0;

  var sheetRow = t.headerRow + 1 + rowIdx;
  var qty = Number(quantity);
  if (isNaN(qty) || qty < 0) qty = 0;
  t.sheet.getRange(sheetRow, t.col.quantity).setValue(qty);
  return 1;
}

/** Write only Is Locked for one drawer. Never touches Part or Quantity. */
function setLocked_(number, locked) {
  var t = locateTable_();
  if (!t) throw new Error('No sheet with a "Part" and "Quantity" header row found.');
  if (!t.col.locked) throw new Error('No Is Locked column found.');

  var rowIdx = findRowByNumber_(t, number);
  if (rowIdx === -1) return 0;

  var sheetRow = t.headerRow + 1 + rowIdx;
  var value = !!locked;
  t.sheet.getRange(sheetRow, t.col.locked).setValue(value);
  colorLockedCell_(t.sheet, sheetRow, t.col.locked, value);
  return 1;
}

function syncSnapshot_(drawers) {
  var t = locateTable_();
  if (!t) throw new Error('No sheet with a "Part" and "Quantity" header row found.');

  var updated = 0;
  for (var i = 0; i < drawers.length; i++) {
    var d = drawers[i];
    var rowIdx = findRowByNumber_(t, d.number);
    var sheetRow;
    if (rowIdx === -1) {
      sheetRow = t.headerRow + t.rows.length + 1;
      t.rows.push(new Array(t.width).fill(''));
      rowIdx = t.rows.length - 1;
      if (t.col.drawer) t.sheet.getRange(sheetRow, t.col.drawer).setValue(d.number);
    } else {
      sheetRow = t.headerRow + 1 + rowIdx;
    }
    if (t.col.part) t.sheet.getRange(sheetRow, t.col.part).setValue(d.part);
    if (t.col.quantity) t.sheet.getRange(sheetRow, t.col.quantity).setValue(d.quantity);
    if (t.col.locked) {
      t.sheet.getRange(sheetRow, t.col.locked).setValue(!!d.locked);
      colorLockedCell_(t.sheet, sheetRow, t.col.locked, !!d.locked);
    }
    updated++;
  }
  return updated;
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

// Session tracker: Name | Team # | Robotics Level | Time | Session ID | Action | Part | Quantity | Locked? | Shelf
function locateSessionTable_() {
  var sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) continue;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var col = {};
    for (var c = 0; c < headers.length; c++) {
      var h = String(headers[c]).trim().toLowerCase();
      if (h === 'name') col.name = c + 1;
      else if (h === 'time' || h === 'timestamp' || h === 'when') col.time = c + 1;
      else if (h === 'session id' || h === 'sessionid') col.sessionId = c + 1;
      else if (h === 'action') col.action = c + 1;
      else if (h === 'part' || h === 'item') col.part = c + 1;
      else if (h === 'shelf' || h === 'drawer') col.shelf = c + 1;
      else if (h === 'quantity' || h === 'qty') col.quantity = c + 1;
      else if (h === 'locked?' || h === 'locked' || h === 'is locked') col.locked = c + 1;
      else if (h === 'team #' || h === 'team#' || h === 'team' || h === 'team number' || h === 'team no' || h === 'team no.') col.team = c + 1;
      else if (h === 'robotics level' || h === 'robotics le' || h === 'level' || h === 'program' || h === 'first program') col.level = c + 1;
    }
    if (col.name && col.sessionId && col.part && col.quantity && col.locked) {
      var lastRow = sheet.getLastRow();
      var width = sheet.getLastColumn();
      // getRange(row, column, numRows, numColumns) — 3rd/4th are COUNTS.
      var numDataRows = Math.max(0, lastRow - 1);
      var rows = numDataRows > 0
        ? sheet.getRange(2, 1, numDataRows, width).getValues()
        : [];
      return { sheet: sheet, headerRow: 1, col: col, rows: rows, width: width };
    }
  }
  return null;
}

function formatTime_(isoOrEmpty) {
  var d = isoOrEmpty ? new Date(isoOrEmpty) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  // Local spreadsheet timezone, readable: 2026-07-13 14:57:02
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function appendSessionRow_(row) {
  var t = locateSessionTable_();
  if (!t) throw new Error('No sheet with Name, Session ID, Part, Quantity, and Locked? headers found.');

  // Always append after the true last row — don't trust a stale in-memory length.
  var sheetRow = Math.max(t.sheet.getLastRow() + 1, t.headerRow + 1);
  var actionLabel = row.actionLabel || '';
  // One setValues write for the whole row beats 8 separate setValue calls.
  var arr = new Array(t.width).fill('');
  if (t.col.name) arr[t.col.name - 1] = row.name || '';
  if (t.col.time) arr[t.col.time - 1] = formatTime_(row.time);
  if (t.col.sessionId) arr[t.col.sessionId - 1] = row.sessionId || '';
  if (t.col.action) arr[t.col.action - 1] = actionLabel;
  if (t.col.part) arr[t.col.part - 1] = row.part || '';
  if (t.col.shelf) arr[t.col.shelf - 1] = row.shelf || '';
  if (t.col.quantity) arr[t.col.quantity - 1] = row.quantity || 0;
  if (t.col.locked) arr[t.col.locked - 1] = !!row.locked;
  if (t.col.team) arr[t.col.team - 1] = row.teamNumber || '';
  if (t.col.level) arr[t.col.level - 1] = row.roboticsLevel || '';
  t.sheet.getRange(sheetRow, 1, 1, t.width).setValues([arr]);
  colorSessionRow_(t, sheetRow, actionLabel, !!row.locked);
  return 1;
}

function mergeAction_(existing, incoming) {
  var prev = String(existing || '').trim();
  var next = String(incoming || '').trim();
  if (!next) return prev;
  if (!prev) return next;

  // Take/return after Unlock → single combined action on that session row.
  if (prev === 'Unlock') {
    if (next === 'Take' || next === 'Unlock + Take') return 'Unlock + Take';
    if (next === 'Return' || next === 'Unlock + Return') return 'Unlock + Return';
  }

  // Lock after a take/return → "Take + Lock" / "Return + Lock"
  if (next === 'Lock') {
    if (prev === 'Take' || prev === 'Unlock + Take') return 'Take + Lock';
    if (prev === 'Return' || prev === 'Unlock + Return') return 'Return + Lock';
    if (prev.indexOf('Lock') !== -1) return prev;
    return 'Lock';
  }

  // Unlock then take/return already arrives as "Unlock + Take" etc. Prefer newer label.
  return next;
}

function updateSessionRow_(row) {
  var t = locateSessionTable_();
  if (!t) throw new Error('No sheet with Name, Session ID, Part, Quantity, and Locked? headers found.');

  var rowIdx = findRowBySessionPart_(t, row.sessionId, row.part);
  if (rowIdx === -1) {
    return appendSessionRow_(row);
  }

  var sheetRow = t.headerRow + 1 + rowIdx;
  var actionLabel = row.actionLabel || '';
  // Edit the in-memory row, then write it back in a single setValues call.
  var arr = t.rows[rowIdx].slice();
  // Keep original check-in time on updates (e.g. Take → Take + Lock); only fill if blank.
  if (t.col.time && !arr[t.col.time - 1]) {
    arr[t.col.time - 1] = formatTime_(row.time);
  }
  if (t.col.locked) arr[t.col.locked - 1] = !!row.locked;
  if (t.col.quantity && row.quantity != null && row.quantity !== 0) {
    arr[t.col.quantity - 1] = row.quantity;
  }
  if (t.col.shelf && row.shelf) {
    arr[t.col.shelf - 1] = row.shelf;
  }
  if (t.col.action) {
    actionLabel = mergeAction_(arr[t.col.action - 1], row.actionLabel);
    arr[t.col.action - 1] = actionLabel;
  }
  if (t.col.team && row.teamNumber) arr[t.col.team - 1] = row.teamNumber;
  if (t.col.level && row.roboticsLevel) arr[t.col.level - 1] = row.roboticsLevel;
  t.sheet.getRange(sheetRow, 1, 1, t.width).setValues([arr]);
  colorSessionRow_(t, sheetRow, actionLabel, !!row.locked);
  return 1;
}

function findRowBySessionPart_(t, sessionId, part) {
  if (!t.col.sessionId || !sessionId) return -1;
  for (var i = t.rows.length - 1; i >= 0; i--) {
    var sameSession = String(t.rows[i][t.col.sessionId - 1]) === String(sessionId);
    var samePart = !t.col.part || String(t.rows[i][t.col.part - 1]) === String(part || '');
    if (sameSession && samePart) return i;
  }
  return -1;
}

// Soft row tint + strong Action / Locked? chips.
function actionColors_(actionLabel) {
  var a = String(actionLabel || '');
  // Take family — warm red
  if (a === 'Take' || a === 'Unlock + Take' || a === 'Take + Lock') {
    return { row: '#FCE8E6', action: '#EA4335', text: '#FFFFFF' };
  }
  // Return family — green
  if (a === 'Return' || a === 'Unlock + Return' || a === 'Return + Lock') {
    return { row: '#E6F4EA', action: '#34A853', text: '#FFFFFF' };
  }
  // Unlock only — blue
  if (a === 'Unlock') {
    return { row: '#E8F0FE', action: '#1A73E8', text: '#FFFFFF' };
  }
  // Lock only — slate
  if (a === 'Lock') {
    return { row: '#F1F3F4', action: '#5F6368', text: '#FFFFFF' };
  }
  return { row: '#FFFFFF', action: '#E8EAED', text: '#202124' };
}

function colorSessionRow_(t, sheetRow, actionLabel, locked) {
  var colors = actionColors_(actionLabel);
  var width = t.width;
  // Light tint across the whole data row
  t.sheet.getRange(sheetRow, 1, 1, width).setBackground(colors.row);

  if (t.col.action) {
    var actionCell = t.sheet.getRange(sheetRow, t.col.action);
    actionCell.setBackground(colors.action);
    actionCell.setFontColor(colors.text);
    actionCell.setFontWeight('bold');
  }

  if (t.col.locked) {
    var lockCell = t.sheet.getRange(sheetRow, t.col.locked);
    if (locked) {
      lockCell.setBackground('#5F6368');
      lockCell.setFontColor('#FFFFFF');
    } else {
      lockCell.setBackground('#34A853');
      lockCell.setFontColor('#FFFFFF');
    }
    lockCell.setFontWeight('bold');
  }

  if (t.col.quantity) {
    var qtyCell = t.sheet.getRange(sheetRow, t.col.quantity);
    qtyCell.setFontWeight('bold');
  }
}

function colorLockedCell_(sheet, row, col, locked) {
  if (!col) return;
  var cell = sheet.getRange(row, col);
  if (locked) {
    cell.setBackground('#5F6368');
    cell.setFontColor('#FFFFFF');
  } else {
    cell.setBackground('#34A853');
    cell.setFontColor('#FFFFFF');
  }
  cell.setFontWeight('bold');
}

function json_(obj) {
  // TEXT is more reliable than JSON mime for Apps Script /exec redirects.
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.TEXT
  );
}
