# SparkyTube server (Render + Supabase)

Update API, download counter and the private admin panel. No dependencies, plain Node.
Secrets can go in `config.js` (keep the repo **private** then) or in Render's environment variables, which win over `config.js`
(`ADMIN_PASSWORD`, `SUPABASE_KEY`, `PUBLIC_URL`, `ADMIN_PATH`...), so the repo can stay clean.

## 1. Supabase

The project `sparkytube-server` (Mumbai) is already created with the tables, `SUPABASE_URL` is filled in.
You only need the secret key: Supabase dashboard > Project Settings > API Keys > copy the
**service_role** (secret) key into `SUPABASE_KEY` in `config.js`. Never put it in the app or the website.

## 2. config.js

Fill in `ADMIN_PASSWORD`, `SESSION_SECRET`, `SUPABASE_KEY` and `PUBLIC_URL`
(the Render address you get in step 3, you can fix it after the first deploy).
Change `ADMIN_PATH` to something only you know.

## 3. Render

1. Push this folder to a new **private** GitHub repo.
2. render.com > New > Web Service > pick the repo.
3. Runtime Node, Build command empty (or `npm install`), Start command `node server.js`, plan Free, region Singapore (closest to the Mumbai database).
4. When it's live, put its address in `PUBLIC_URL` (config.js) and push again.

Open `https://<service>.onrender.com/<ADMIN_PATH>` for the panel.

## 4. Point the app and the site at it

- `app/.../update/UpdateManager.kt`: `BASE`
- `index.html`: `var API`

Both default to `https://sparkytube-api.onrender.com`, change them if your service has another name.

## Release flow

1. Push the app code, CI builds the APKs, create the GitHub release (v2.1) with the universal APK.
2. Panel > Releases > **Import from GitHub**, enter the version code (the number in build.gradle.kts), done.
   Or paste the apk links by hand.
3. Apps see it on the next check and the website shows the new version.

## Notes

- The free Render plan sleeps after ~15 minutes without traffic, the first request then takes up to a minute.
  The app falls back to the GitHub release while the server wakes. A free uptime pinger on `/health` keeps it awake if you want.
- Free Supabase projects pause after a week with no activity, the app's background checks keep it active.
- APKs are not stored here, they stay on GitHub Releases. This server only redirects and counts.
- Version code must go up with every release.
