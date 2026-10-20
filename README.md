# ADSTYLE Attendance (Vercel)

Kiosk at `/`, admin at `/admin`. Data in Neon Postgres, photos in Vercel Blob.

1. Copy Kiosk.html and Admin.html from your Apps Script project into this folder.
2. `python prepare.py` writes public/index.html and public/admin.html.
3. Push to GitHub, import the repo in Vercel (no build command).
4. In the Vercel project's Storage tab: create a Neon Postgres database and a Blob store (Public) and connect both.
5. Settings > Environment Variables: ADMIN_PIN (your PIN), APP_TZ (default Asia/Kolkata). Redeploy.
Tables are created automatically on the first request.
