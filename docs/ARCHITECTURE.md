# Git2App — Architecture & Engineering Decisions

Version 0.1 · 2026-10-30 · owner: Shubham (`shubhamrkrock`)

This document records the architecture and the security/engineering choices made for
Git2App, the platform that converts a GitHub-hosted web app or PWA into installable
Android (APK/AAB) and iOS (IPA) packages. It is the companion to the PRD; where the PRD
says *what*, this says *how* and *why*. The first concrete target is the **Xpenstack**
PWA (`shubhamrkrock/Xpenstack`), a React + Vite + TypeScript PWA.

The owner asked to be hands-off: the security and architecture choices are made here, and
the only things that genuinely need the owner's hands are listed in
[§11 Owner action items](#11-owner-action-items).

---

## 1. Guiding principles (from PRD §23, binding)

These are enforced in code and in review, not just stated:

1. Never assume every repository is a PWA — the analyzer reports, it does not presume.
2. Never assume every PWA packages without modification.
3. Android and iOS get an **independent** strategy recommendation.
4. **Never compile iOS on Linux.** iOS archive/export runs only on a macOS runner.
5. Signing credentials never reach frontend code or build logs.
6. Untrusted repositories never execute in the orchestrator's environment — only inside
   a disposable, network-restricted build worker.
7. Never overwrite a user's repository without explicit, per-request authorization.
8. An IPA/AAB existing is not store approval — the platform never claims otherwise.
9. Never silently drop app functionality to make a build go green.
10. Always preserve the original repo and the exact commit SHA that was built.
11. Build errors are actionable: stage, cause, suggested fix.
12. Builds are reproducible: pinned toolchain image + pinned commit + recorded config.
13. Generated artifacts are validated before a download link is offered.
14. Package generation and store submission are separate steps.

## 2. System shape

```
                 USER (browser)
                   │
                   ▼
          React + Vite SPA  (apps/web, Cloudflare Pages)
                   │  HTTPS, Supabase session JWT
                   ▼
        Cloudflare Worker API  (apps/api)  ── validates ownership on every call
          │            │               │
          ▼            ▼               ▼
     Supabase Auth  Supabase PG   GitHub App  (short-lived installation tokens)
                      │  (RLS)
                      ▼
            Build orchestrator (Worker + Queue)
                      │  workflow_dispatch (ids only); worker proves itself with GitHub OIDC
          ┌───────────┴─────────────┐
          ▼                          ▼
   g2a-job.yml (Ubuntu VM)     g2a-ios.yml (macOS VM)
   GitHub Actions, fresh VM    GitHub Actions, fresh VM
   Node+JDK 21+SDK 36+Gradle   Node+Xcode 26 (Swift PM)
   Bubblewrap / Capacitor      Capacitor iOS
          │  release builds: unsigned outputs → separate signing job (g2a-signing env)
          │                          │
          ▼                          ▼
        AAB/APK                     IPA
          └────────────┬────────────┘
                        ▼
              Cloudflare R2 (private)
                        │  short-lived signed URL
                        ▼
                  USER download
```

The orchestrator **coordinates**; it never compiles. Compilation is delegated to isolated
workers that pull the repo, build, and push artifacts to R2, reporting status back through
a signed callback. This is the single most important structural decision (PRD §11.1).

## 3. Component map (this repo is a monorepo)

| Path | What it is | Runtime |
|---|---|---|
| `apps/web` | React + Vite + TS dashboard and new-project wizard | Browser / CF Pages |
| `apps/api` | Cloudflare Worker: REST API `/api/v1/*`, webhooks, orchestration | CF Workers |
| `packages/shared` | Types, build state machine, validation helpers shared by all | Node + Worker |
| `packages/analyzer` | **Deterministic** repo analyzer: framework, PWA, build, strategy | Node (worker + CLI) |
| `packages/generator` | Produces Capacitor / Bubblewrap project scaffolds from a config | Node |
| `packages/runner` | The agent that runs inside a build worker: clone→build→package→upload | Node |
| `infra/android-builder` | Dockerfile + scripts for the pinned Linux Android image | Docker |
| `.github/workflows` | iOS macOS build workflow, Android build workflow, CI | GitHub Actions |
| `supabase/migrations` | SQL schema + RLS policies | Postgres |
| `tests` | `node --test` suites, no test framework dependency | Node |

Rationale for the split: the **analyzer** is pure, deterministic, and independently
testable — the PRD insists detection be based on real config/dependency analysis, and that
AI never be responsible for the actual verdict (§15). The **runner** is the only code that
touches untrusted repository contents, so it is isolated in its own package with the
narrowest possible surface.

## 4. Technology choices and why

| Layer | Choice | Why (and alternatives rejected) |
|---|---|---|
| Frontend | React + Vite + TS, Tailwind | PRD §11.1; matches Xpenstack's own stack so skills transfer. |
| Auth | Supabase Auth (Google, GitHub, email) | PRD §4.1; RLS ties identity to data rows. |
| DB | Supabase Postgres + RLS | PRD §11.3; tenant isolation at the row, not the UI. |
| API | Cloudflare Workers | PRD §11.1; cheap, edge, no server to patch. Rejected: a long-running Node API (ops burden, cost). |
| Queue | Cloudflare Queues | PRD §11.1; decouples request from build. |
| Git | **GitHub App** (not OAuth app) | PRD §4.2; per-repo grants, short-lived installation tokens, webhooks. |
| Build workers | **GitHub Actions** in this (private) repo: `g2a-job.yml` on Ubuntu, `g2a-ios.yml` on macOS | A fresh VM per job, OIDC identity, no servers to run. Rejected for now: our own container fleet (ops cost), Codemagic (a second CI identity to secure; still a fallback for macOS minutes). |
| Android build | Ubuntu VM, JDK 21, Android SDK 36, Gradle, Capacitor 8.6 (default) or Bubblewrap 1.27 (TWA) | PRD §6. |
| iOS build | macOS VM, Xcode 26, Capacitor 8.6 with Swift Package Manager (no CocoaPods) | PRD §7. Private-repo macOS minutes cost 10x Linux minutes, so e2e iOS runs are manual. |
| Artifacts | Cloudflare R2, private, signed URLs | PRD §16.3. |
| Secrets | Envelope encryption; data key per credential, master key in Worker secret / KMS | PRD §12.8, §16.2. Keys never stored beside ciphertext. |
| AI analysis | LLM API as an **advisor** over the analyzer's structured output | PRD §15; deterministic tooling owns the verdict. |

### 4.1 Why Capacitor is the default, TWA the special case

Capacitor embeds the built web output in a native shell and supports both platforms with
one strategy, native plugins, and offline. TWA (Android only, via Bubblewrap) is lighter
but requires the developer to own the domain and publish Digital Asset Links, and gives
limited native access. The engine therefore recommends **per-platform**:

- **Android**: TWA when the PWA is hosted on HTTPS on a domain the user controls, asset
  links are configurable, and native needs are limited; otherwise Capacitor.
- **iOS**: Capacitor always (no TWA equivalent). A pure web wrapper risks Apple's minimum
  functionality rejection, which the store-readiness report flags rather than hides.

For Xpenstack specifically: it is a React+Vite PWA served on `app.xpenstack.com` that the
owner controls, but it needs native features (push via FCM, file share sheet, deep links
for `xpenstack://auth/callback`, biometric-gated storage later). So the recommendation is
**Capacitor for both platforms** — which also matches the Capacitor 8 store-shell work
already begun in the Xpenstack repo (`claude/store-shell`). Git2App will be able to
reproduce that shell from config rather than by hand.

## 5. Data model

See `supabase/migrations`. Tables (PRD §12): `profiles`, `github_installations`,
`projects`, `project_analyses`, `app_configurations`, `builds`, `build_artifacts`,
`signing_credentials`. Every row carries a `user_id`; every table has RLS enabled with a
policy of `user_id = auth.uid()`. `signing_credentials` additionally:

- stores only `encrypted_payload` (BYTEA) + `key_reference`; the encryption key lives in a
  Worker secret / KMS, never in the DB;
- is readable by **no** anon/authenticated policy for its payload column — the Worker reads
  it with the service role only inside a build dispatch, and decrypts in-worker.

## 6. Build lifecycle (PRD §10.1)

`CREATED → QUEUED → ANALYZING → DEPENDENCY_INSTALLATION → WEB_BUILD →
NATIVE_CONFIGURATION → PLATFORM_COMPILATION → SIGNING → VALIDATION → COMPLETED`, with
per-stage failure states. The state machine lives in `packages/shared/src/build-state.ts`
so the API, the runner, and the UI agree on transitions. Illegal transitions throw.

## 7. Security architecture (PRD §16)

**Who can start a build.** Only the API, through `workflow_dispatch` with ids as inputs. The
workflows pin the API origin to the `G2A_API_ORIGIN` repository variable and refuse any other.

**How a worker proves itself.** It sends its GitHub OIDC token (audience = the API origin) to
`/internal/jobs/:kind/:id/claim`. The API checks the issuer and key, this repository,
`refs/heads/main`, the `workflow_dispatch` event and the workflow file (iOS builds only from
`g2a-ios.yml`, the rest only from `g2a-job.yml`). A claim is single-use and records the run id;
the API then issues an HMAC job ticket bound to that one job.

**What a build worker gets.** The job spec: a clone token narrowed to the one repository with
`contents: read`, the commit SHA and the app configuration. Never signing keys.

**Untrusted code (Linux).** The repository's install and build scripts, Gradle and the
Capacitor CLI run as the `g2a` user (`scripts/worker/setup-linux.sh`): no sudo, an environment
rebuilt from an allow-list (`sandboxEnv`, which also drops anything named like a runner or
Actions token), no access to the runner's home (mode 700), and iptables rules that reject cloud
metadata, the Azure wire server and private ranges for that user. The job folder sits outside
the runner's home and is shared through ACLs; the runner takes it back (killing every `g2a`
process first) before it packages anything. The e2e workflow checks all of this from inside a
real build: the fixture's build script records what it could reach and the check fails if it
saw a token, the runner's files or the metadata service.

**Untrusted code (macOS).** The same scrubbed environment, but no separate user yet. The worker
still holds no signing keys, so the exposure is the job's own clone token and ticket for the
rest of that job. A sandbox user on macOS is a follow-up.

**Signing.** Release builds stop at SIGNING with unsigned outputs. A separate job in the same
run, on a fresh VM, in the `g2a-signing` GitHub environment, downloads them and asks
`/internal/jobs/build/:id/signing` for the keys. The API releases them only to an OIDC token
with `environment: g2a-signing` from the run that claimed the build, while the build is at
SIGNING, for a release variant; every release is an audit event. The signing job never runs
repository code. Android: zipalign + apksigner and jarsigner with passwords passed through the
environment, keystore written 0600 and deleted. iOS: a throwaway keychain with a random
password, profile checked against the bundle id, team, expiry, distribution type and push.

**Credentials at rest.** AES-GCM envelope encryption with a per-credential data key; the
master key is a Worker secret; the additional data binds a ciphertext to its user and
credential id. The browser can see only metadata (`signing_credentials_meta`).

**Logs and artifacts.** Every log line is redacted on the worker (registered secrets and their
base64 form, token patterns) and again on the API. Artifacts are checksummed on arrival;
packages are downloadable only when the worker's validation stage passed, through 10-minute
signed links. The workers repository is private, so Actions logs are not public.

**Known gaps.** Actions are referenced by major tag, not commit SHA; pin them once the owner
picks a Dependabot policy. Egress is not allow-listed beyond the private-range block, because
builds legitimately fetch from npm, Maven and Google.

## 8. Reproducibility

A build records: the toolchain id (`TOOLCHAIN.id` in `packages/generator`, every native
package pinned exactly), the runner image, commit SHA, resolved lockfile and the full
`app_configurations` snapshot (`build-report.json`, uploaded with every build). Re-running with the same inputs and image
digest yields the same artifact (modulo signing timestamps).

## 9. Phasing (maps to PRD §20) and what this repo delivers first

- **Phase 1 Foundation** — schema + RLS, Worker API skeleton with ownership checks, GitHub
  App integration (installation tokens, repo listing). The dashboard (`apps/web`): sign-in,
  apps list, new app, check report, settings, build with live steps and log, downloads,
  GitHub connections and signing keys. Logic in `apps/web/src/lib` is tested by `tests/web.test.ts`.
- **Phase 2 Analysis** — deterministic analyzer + compatibility/strategy engine, tested
  against the twelve PRD §21.1 fixtures **and** against the real Xpenstack repo. *(this PR)*
- **Phase 3 Android** — Capacitor + Bubblewrap generation, Gradle debug APK and release
  APK/AAB, separate signing job, validation, R2. *(this PR; compile proven by `e2e.yml`)*
- **Phase 4 iOS** — macOS workflow, simulator build, unsigned archive, signing job, IPA.
  *(this PR; first real run needs macOS minutes and Apple credentials)*
- **Phase 5 Testing/validation; Phase 6 webhooks/automation; Phase 7 commercial.**

## 10. MVP scope we are building toward (PRD §22)

Inputs: React, Vite, standard JS/TS web apps, valid hosted PWAs. Android outputs: debug
APK, signed APK, signed AAB, Capacitor project, TWA project where appropriate. iOS outputs:
Capacitor project, signed IPA, Xcode project zip. Deferred: auto store submission, complex
plugin generation, team collaboration, AI code modification.

## 11. Owner action items

The step-by-step list is `docs/SETUP.md`. In short: create the GitHub App, a Supabase project,
the Cloudflare pieces, the `g2a-signing` environment and `G2A_API_ORIGIN` variable in this
repo, and, for store builds, the Google Play upload key and Apple distribution certificate,
profile and App Store Connect key.

Until those exist the e2e workflow still proves the pipeline: it builds the fixture PWA into a
debug APK on every change, and an iOS simulator app on request.
