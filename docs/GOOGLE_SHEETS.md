# Google Sheets as inventory source

When `SHEETS_WEBHOOK_URL` and `SHEETS_SECRET` are set, the **inventory sheet
owns Part, Quantity, Is Locked, and Image**. The app reads those columns before
showing drawers and before take/return. It never rewrites Part, Locked, or Image
from seeded app data.

Take/return **only** patch the Quantity cell for that drawer. Session tracker
rows are append-only (separate sheet).

## One-time setup (~5 minutes)

1. **Open your spreadsheet** →
   `https://docs.google.com/spreadsheets/d/1rhm8XpNQIIIrtaBwIB6tTSrOwbP3zScRpPm-DGeni_U/edit`
2. **Extensions → Apps Script.** Paste
   [`google-apps-script/Code.gs`](../google-apps-script/Code.gs). Save.
3. **Script property** `SECRET` = a long random string.
4. **Deploy → New deployment** (Web app, Execute as Me, Anyone) → copy `/exec` URL.
5. **Env** (local + Vercel):

   ```bash
   SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/AKfyc.../exec
   SHEETS_SECRET=the-same-secret
   SESSION_SECRET=another-long-random-string
   ```

6. Redeploy Apps Script with **New version** after any `Code.gs` change.

## Sheet layout

**Inventory**

| # Drawer | Part | Quantity | Is Locked | Image |
|----------|------|----------|-----------|-------|
| 1 | Cat6 Patch Cable 1m | 64 | TRUE | _(image in cell)_ |

Drawer numbers must match app labels (`Drawer 1` → `1`).

### Image column (feeds the drawer photo)

Add a column headed **Image** (also accepts Photo / Img / Picture).

The app reads that column on every Refresh. Preferred setup:

1. Select the Image cell for that drawer.
2. **Insert → Image → Image in cell**.
3. In the sheet: **QR Cabinet → Connect images to app**  
   (or just tap **Refresh** in the app — first sync converts the cell to
   `=IMAGE("…")` and hosts the file in Drive).
4. When Google asks, allow **Drive** access.
5. Tap **Refresh** again in the app — it should briefly show `1 photo`.

**Also works without conversion:** paste a Drive/https link in the Image cell,
or add a **Photo URL** column with the link.

Empty Image cells keep the wire placeholder.

**Debug:** Apps Script → Run `debugDrawerPhotos` → View → Logs.

**Session tracker**

| Name | Time | Session ID | Action | Part | Shelf | Quantity | Locked? | Team # | Level |

Add **Team #** and **Level** (or Robotics Level) columns so check-in data is
logged with each take/return. The inventory sheet may also have those columns —
they get stamped with the visitor’s team when they use a drawer.

## Behavior

- **Read:** `inventory` → fills the UI from the sheet (including Image).
- **Take/return:** `set_quantity` / `tx` → updates that row’s Quantity only.
- **Refresh button:** pulls from the sheet again (does not push inventory).
- **Lock/unlock:** patches inventory **Is Locked** and appends/updates the session
  tracker. Redeploy Apps Script with **New version** after `Code.gs` changes.
- Full `snapshot` overwrites are disabled.

## Architecture note

Sheets is fine as shared workshop inventory. It is not a transactional DB. For
strong concurrency, use PostgreSQL later and keep Sheets as ops UI.

### Latency

The Apps Script **Web App** cold-starts slowly (often 5–15s). The app mitigates this:

1. **Menu load** waits briefly for Sheets, then returns and finishes the pull in
   the background; the drawers page soft-refreshes until data is fresh.
2. **In-flight dedupe + 30s cache** so concurrent requests don’t pile on.
3. **Cron warmup** (`/api/sheets/warmup` once daily via `vercel.json`) pings
   Apps Script so it has a chance to stay warm. On **Vercel Pro** you can change
   the schedule to `*/5 * * * *` for every-5-minute warming (Hobby only allows
   daily crons — more frequent schedules fail the deploy).

Optional: set `CRON_SECRET` in Vercel and Vercel will send it automatically on
cron invocations.

For near–real-time reads without Apps Script delay, switch later to the
**Google Sheets API** with a service account (typical ~200–500ms). That needs
service-account JSON in Vercel env and sheet sharing with the SA email.
