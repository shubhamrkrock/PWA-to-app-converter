# Git2App setup: the steps only the owner can do

The phone-friendly version, with Open buttons, Copy buttons and screenshot slots, is
`docs/setup/git2app-setup.html` (published at https://claude.ai/artifact/RyyqfUC6nGzdYqeMBKLUKY).
Keep the two in step.

Everything else is code in this repository. Each step says what to create, the exact settings,
and where the value goes. Secret values never go in a file, a chat or a commit: they go
straight into the place named (Cloudflare Worker secrets, GitHub settings, Supabase settings).

Placeholders used below: `API` is the API's address, `WEB` is the dashboard's address. The owner's
are on his own domain (1 Nov 2026): `API` = `https://git2app-api.xpenstack.com`,
`WEB` = `https://git2app.xpenstack.com`. Both sit one level below the domain, so Cloudflare's free
certificate covers them (`api.git2app.xpenstack.com` would need a paid certificate).

## 0. What works before any of this

The **e2e** workflow (Actions tab, "e2e") builds the test PWA in `tests/fixtures/e2e-pwa` into a
debug APK on every change to the build code, inside the build sandbox, and checks the sandbox
from inside the APK. Run it by hand with "Run workflow"; tick "ios" to also build the iOS
simulator app (uses macOS minutes, see step 6). The APK is in the run's "e2e-android" artifact
and installs on any Android phone with "install unknown apps" allowed.

## 1. GitHub: the Git2App App (the one users install)

GitHub > Settings > Developer settings > GitHub Apps > New GitHub App.

| Setting | Value |
|---|---|
| Name | Git2App (the slug goes in `GITHUB_APP_SLUG` in `apps/api/wrangler.toml`) |
| Homepage URL | `WEB` |
| Redirect URI (was "Callback URL") | `API/api/v1/github/callback` |
| Request user authorization (OAuth) during installation | **On** (the API uses it to prove the installer can see the installation) |
| Webhook URL | `API/api/v1/github/webhooks` |
| Webhook secret | a long random value (the guide's Make one button), also stored as `GITHUB_WEBHOOK_SECRET` |
| Repository permissions | Contents: **Read-only**. Metadata: Read-only. Nothing else. |
| Subscribe to events | Push |
| Where can it be installed | "Only on this account" for now; "Any account" when Git2App opens to others |

After creating it:
1. Note the **App ID** and the **Client ID**; generate a **client secret**.
2. Generate a **private key** (Credentials > Key pairs > New key; a `.pem` download). Keep it
   as downloaded: the API reads GitHub's PKCS#1 file directly, no conversion.
3. Delete the downloaded file once it is stored as a secret (step 5).

## 2. GitHub: the Git2App Workers App (private, only on this repository)

It lets the API start and cancel build runs here. Keeping it separate means users are never
asked to give Git2App access to Actions in their own repositories.

| Setting | Value |
|---|---|
| Name | Git2App Workers |
| Webhook | **Off** |
| Repository permissions | Actions: **Read and write**. Metadata: Read-only. |
| Where can it be installed | Only on this account |

Install it on **this repository only** (`PWA-to-app-converter`). The installation's settings
page address ends in the **installation id**; it goes in `WORKERS_INSTALLATION_ID`. Generate
its private key as in step 1.

## 3. GitHub: settings of this repository

1. Settings > Secrets and variables > Actions > **Variables**: `G2A_API_ORIGIN` = `API`
   (exactly, no trailing slash). The workflows refuse to run for any other origin.
2. Settings > Environments > New environment **`g2a-signing`**. Deployment branches: "Selected
   branches", add `main`. No secrets in it: the API releases keys only to jobs in this
   environment, after checking their GitHub identity token.
3. The repository is **public** since 31 Oct 2026 (free build minutes). Build logs, and for one day
   a release build's unsigned handoff, are then readable by anyone. Fine for the owner's own
   apps whose web code is public anyway; before Git2App builds other people's private repos,
   move the workers to a private repository (paid minutes) or another build service.
4. Settings > Actions > General > Workflow permissions: "Read repository contents".

## 4. Supabase

1. New project (separate from Xpenstack's), region close to most users.
2. SQL editor: run `supabase/migrations/0001_init.sql`, `0002_analysis_jobs.sql`,
   `0003_simulator_artifact.sql`, in order.
3. Authentication > Providers: GitHub, Google and Email.
4. Project Settings > JWT: use **asymmetric signing keys** (ES256). The API verifies sessions
   against the project's public key set and refuses shared-secret (HS256) tokens.
5. Note the **project URL** and the **anon key** (for the dashboard) and the **service role
   key** (API only, step 5).
6. Authentication > URL Configuration: Site URL = `WEB`; add `WEB/projects` to the redirect URLs.
7. The signing vault is off on the free plan. For your own account, once you have signed in
   once, run in the SQL editor:
   `update public.profiles set subscription_plan = 'pro' where id = (select id from auth.users where email = 'YOUR EMAIL');`

## 5. Cloudflare

All in the Cloudflare dashboard; nothing runs on the owner's computer.

1. R2: create bucket `git2app-artifacts` (private, no public access).
2. Queues: create `git2app-dispatch` and `git2app-dispatch-dlq`.
3. `apps/api/wrangler.toml` holds `API_ORIGIN`, `WEB_ORIGIN` and `GITHUB_APP_SLUG` (set 1 Nov 2026),
   and a `routes` entry with `custom_domain = true`: on deploy Cloudflare creates the API's DNS
   record and certificate itself (the domain must be in the same Cloudflare account). The
   workers.dev address is turned off (`workers_dev = false`).
4. Workers & Pages > Create > Import a repository > this repository. Project name `git2app-api`,
   build command `npm ci`, deploy command `npx wrangler deploy --config apps/api/wrangler.toml`,
   root directory empty, production branch `main`. Wrangler is pinned in `apps/api/package.json`.
5. Worker > Settings > Variables and Secrets > Add, type **Secret**, one per row:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | from step 1 |
| `GITHUB_APP_PRIVATE_KEY` | the whole `.pem` file from step 1, as downloaded |
| `GITHUB_WEBHOOK_SECRET` | from step 1 |
| `WORKERS_APP_ID`, `WORKERS_APP_PRIVATE_KEY` | from step 2 (the `.pem` as downloaded) |
| `WORKERS_INSTALLATION_ID` | from step 2 |
| `STATE_SECRET`, `TICKET_SECRET` | random 32 bytes each (the guide's Make one button), different values |
| `CREDENTIALS_MASTER_KEY` | random 32 bytes; losing it makes stored signing keys unreadable, so keep a copy in a password manager |

6. Pages: Workers & Pages > Create > Pages > connect this repository. Build command
   `npm ci && npm run build:web`, output folder `apps/web/dist`, production branch `main`.
   Environment variables (all public, none is a secret): `VITE_SUPABASE_URL` (project URL),
   `VITE_SUPABASE_ANON_KEY` (anon key), `VITE_API_ORIGIN` (`API`). Then the Pages project >
   Custom domains > Set up a custom domain > the host of `WEB` > Activate domain.

## 6. Build minutes

This repository is public (since 31 Oct 2026), so standard GitHub-hosted runners, Linux and
macOS, are free with no minute cap. If it is made private again, minutes count against the
account's allowance (2,000 a month on the free plan) and macOS minutes count ten times.

## 7. Store signing (only for signed release builds)

Debug builds need none of this.

**Google Play (Android)**
1. Create an upload key once and keep it safe; Play App Signing holds the real app key:
   ```
   keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
   ```
2. Upload it to Git2App as an "android-keystore" credential (keystore, store password, alias,
   key password). It is encrypted before it is stored and never shown again.

**Apple (iOS)**
1. Apple Developer: an **Apple Distribution** certificate, exported from Keychain Access with its
   private key as a `.p12` with a password.
2. An **App Store** provisioning profile for the bundle id (for Xpenstack `com.xpenstack.app`),
   with Push Notifications if the app uses them.
3. The **Team ID** (Membership page).
4. Upload all three to Git2App as an "ios-certificate" credential. The signing job checks the
   profile's team, bundle id, expiry, type and push capability before signing.
5. For upload to App Store Connect later: an App Store Connect API key ("asc-api-key").

Xpenstack's own guides for these accounts are in its `docs/setup/` folder.
