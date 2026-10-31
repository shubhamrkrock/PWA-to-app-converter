# Git2App setup: the steps only the owner can do

Everything else is code in this repository. Each step says what to create, the exact settings,
and where the value goes. Secret values never go in a file, a chat or a commit: they go
straight into the place named (`wrangler secret put`, GitHub settings, Supabase settings).

Placeholders used below: `API` is the API's address (for example `https://api.git2app.dev`),
`WEB` is the dashboard's address (for example `https://git2app.dev`).

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
| Callback URL | `API/api/v1/github/callback` |
| Request user authorization (OAuth) during installation | **On** (the API uses it to prove the installer can see the installation) |
| Webhook URL | `API/api/v1/github/webhooks` |
| Webhook secret | a long random value (`openssl rand -hex 32`), also stored as `GITHUB_WEBHOOK_SECRET` |
| Repository permissions | Contents: **Read-only**. Metadata: Read-only. Nothing else. |
| Subscribe to events | Push |
| Where can it be installed | "Only on this account" for now; "Any account" when Git2App opens to others |

After creating it:
1. Note the **App ID** and the **Client ID**; generate a **client secret**.
2. Generate a **private key** (a `.pem` download). The API needs PKCS#8:
   ```
   openssl pkcs8 -topk8 -nocrypt -in git2app.*.private-key.pem -out git2app-pkcs8.pem
   ```
3. Delete the downloaded files once they are stored as secrets (step 4).

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
and convert its private key as in step 1.

## 3. GitHub: settings of this repository

1. Settings > Secrets and variables > Actions > **Variables**: `G2A_API_ORIGIN` = `API`
   (exactly, no trailing slash). The workflows refuse to run for any other origin.
2. Settings > Environments > New environment **`g2a-signing`**. Deployment branches: "Selected
   branches", add `main`. No secrets in it: the API releases keys only to jobs in this
   environment, after checking their GitHub identity token.
3. Keep the repository **private**: build logs and artifacts of users' apps live here.
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

## 5. Cloudflare

1. R2: create bucket `git2app-artifacts` (private, no public access).
2. Queues: create `git2app-dispatch` and `git2app-dispatch-dlq`.
3. In `apps/api/wrangler.toml` set `API_ORIGIN`, `WEB_ORIGIN` and `GITHUB_APP_SLUG`.
4. From `apps/api`, store each secret with `npx wrangler secret put NAME`:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | from step 1 |
| `GITHUB_APP_PRIVATE_KEY` | contents of `git2app-pkcs8.pem` |
| `GITHUB_WEBHOOK_SECRET` | from step 1 |
| `WORKERS_APP_ID`, `WORKERS_APP_PRIVATE_KEY` | from step 2 (PKCS#8 key) |
| `WORKERS_INSTALLATION_ID` | from step 2 |
| `STATE_SECRET`, `TICKET_SECRET` | each `openssl rand -base64 32`, different values |
| `CREDENTIALS_MASTER_KEY` | `openssl rand -base64 32`; losing it makes stored signing keys unreadable, so keep a copy in a password manager |

5. `npx wrangler deploy`, then add the custom domain for `API` to the Worker.

## 6. Build minutes

This repository is private, so Actions minutes count against the account's allowance, and
macOS minutes count ten times. On the free plan (2,000 minutes a month) that is roughly 200
macOS minutes: about 10 to 15 iOS builds, or fewer if Android and analysis jobs use the rest.
Options when that runs out: GitHub Pro (3,000 minutes), paid minutes, or Codemagic as a second
macOS worker (not built yet).

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
