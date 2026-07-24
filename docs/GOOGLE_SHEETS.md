# Google Sheets as inventory source

When Sheets is configured, the **inventory sheet owns Part, Quantity, Is Locked,
and Image**. The app reads those columns and patches Quantity / Is Locked on
take/return/lock. Session tracker rows are append-only (separate sheet).

## Fast path (recommended): Google Sheets API

Apps Script Web Apps are often **5–15s** when cold. The Sheets API is typically
**200–800ms**. Use this for workshop speed.

1. Open [Google Cloud Console](https://console.cloud.google.com/) → create/select a project.
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create credentials → Service account**.
4. Open the service account → **Keys → Add key → JSON** → download the file.
5. Open your spreadsheet → **Share** → add the service account email
   (`…@….iam.gserviceaccount.com`) as **Editor**.
6. Spreadsheet ID is the long id in the URL:
   `https://docs.google.com/spreadsheets/d/<SHEETS_SPREADSHEET_ID>/edit`
7. Set Vercel / `.env.local`:

   ```bash
   SHEETS_SPREADSHEET_ID=1rhm8XpNQIIIrtaBwIB6tTSrOwbP3zScRpPm-DGeni_U
   GOOGLE_SERVICE_ACCOUNT_EMAIL=qr-cabinet@YOUR_PROJECT.iam.gserviceaccount.com
   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   SESSION_SECRET=another-long-random-string
   ```

   Or set `GOOGLE_SERVICE_ACCOUNT_JSON` to the entire JSON key (one line).

8. Redeploy the app. Take/return/lock and light inventory pulls use the API.
   Apps Script is only needed for Image-column photos (see below).

## Apps Script (images only)

Qty / lock / session tracker use the Sheets API above. Apps Script is **only**
for the Image column (Refresh photos).

1. **Open your spreadsheet** → Extensions → Apps Script.
2. Replace `Code.gs` with [`google-apps-script/Code.gs`](../google-apps-script/Code.gs). Save.
3. Script property `SECRET` = same as `SHEETS_SECRET`.
4. Run `authorizeImageAccess` once → Allow.
5. **Deploy → New version** (Web app, Execute as Me, Anyone) → copy `/exec` URL.
6. Env (local + Vercel):

   ```bash
   SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/AKfyc.../exec
   SHEETS_SECRET=the-same-secret
   ```

7. Sheet menu **QR Cabinet → Connect images to app**, then **Refresh** in the app.

## Sheet layout

**Inventory**

| # Drawer | Part | Quantity | Is Locked | Image |
|----------|------|----------|-----------|-------|
| 1 | Cat6 Patch Cable 1m | 64 | TRUE | _(image in cell)_ |

Drawer numbers must match app labels (`Drawer 1` → `1`).

### Image column (feeds the drawer photo)

Add a column headed **Image** (also accepts Photo / Img / Picture).

The app reads that column on **Refresh** (Apps Script path). Preferred setup:

1. Select the Image cell for that drawer.
2. **Insert → Image → Image in cell**.
3. In the sheet: **QR Cabinet → Connect images to app**
4. When Google asks, allow **Drive** access.
5. Tap **Refresh** again in the app.

**Session tracker**

| Name | Team # | Robotics Level | Time | Session ID | Action | Part | Quantity | Locked? | Shelf |

## Behavior

- **Read:** light inventory via Sheets API when configured; photos via Apps Script Refresh.
- **Take/return/lock:** Sheets API when configured, else Apps Script `tx` / `lock_tx`.
- Full `snapshot` overwrites are disabled.

## Architecture note

Sheets is fine as shared workshop inventory. It is not a transactional DB. For
strong concurrency, use PostgreSQL later and keep Sheets as ops UI.
