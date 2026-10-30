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
                      │  signed, single-use job tickets
          ┌───────────┴─────────────┐
          ▼                          ▼
   Android worker (Linux)      iOS worker (macOS)
   ephemeral container         GitHub Actions maceOS / Codemagic
   Node+JDK+SDK+Gradle         Node+Xcode+CocoaPods
   Bubblewrap / Capacitor      Capacitor iOS
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
| Android build | Linux container, JDK 21, Android SDK, Gradle, Bubblewrap + Capacitor | PRD §6. |
| iOS build | **macOS runner** (GitHub Actions `macos-15`, Codemagic as alt) | PRD §7; the owner already uses Codemagic free Macs for Xpenstack. |
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

- **Isolation**: each build runs in a fresh container/VM, non-root, CPU/mem/time capped,
  egress restricted to an allowlist (npm, the chosen repo host, Google/Maven for Android,
  Apple for iOS). No access to orchestrator secrets; it receives only a single-use,
  short-TTL job ticket and a scoped R2 upload credential.
- **Repo contents are untrusted**: the runner extracts archives with path-traversal
  guards, never runs lifecycle scripts it was not asked to (`npm ci --ignore-scripts`
  where feasible, else inside the sandbox only), and treats `package.json` scripts as data
  to be shown, not silently executed outside the sandbox.
- **Credentials**: envelope encryption; secrets are redacted from every log line by a
  redaction pass keyed on known secret substrings before persistence.
- **Storage**: private R2, short-lived signed download URLs, SHA-256 checksums, expiry.
- **Privacy**: disconnecting GitHub revokes the installation and deletes cached repo
  copies per retention policy. Private source is never sent to train external models.

## 8. Reproducibility

A build records: toolchain image digest, Node version, commit SHA, resolved lockfile hash,
and the full `app_configurations` snapshot. Re-running with the same inputs and image
digest yields the same artifact (modulo signing timestamps).

## 9. Phasing (maps to PRD §20) and what this repo delivers first

- **Phase 1 Foundation** — schema + RLS, Worker API skeleton with ownership checks, GitHub
  App integration (installation tokens, repo listing), web dashboard shell. *(this PR)*
- **Phase 2 Analysis** — deterministic analyzer + compatibility/strategy engine, tested
  against the twelve PRD §21.1 fixtures **and** against the real Xpenstack repo. *(this PR)*
- **Phase 3 Android** — Linux image, Capacitor + Bubblewrap generation, APK/AAB, R2.
- **Phase 4 iOS** — macOS workflow, Capacitor iOS, archive, IPA.
- **Phase 5 Testing/validation; Phase 6 webhooks/automation; Phase 7 commercial.**

## 10. MVP scope we are building toward (PRD §22)

Inputs: React, Vite, standard JS/TS web apps, valid hosted PWAs. Android outputs: debug
APK, signed APK, signed AAB, Capacitor project, TWA project where appropriate. iOS outputs:
Capacitor project, signed IPA, Xcode project zip. Deferred: auto store submission, complex
plugin generation, team collaboration, AI code modification.

## 11. Owner action items

Things only Shubham can do (accounts/credentials). The platform is built so these are the
*only* manual steps:

1. **Create the Git2App GitHub App** (owner of the GitHub org) and give the platform its
   App ID, private key, and webhook secret. Needed for repo listing and webhooks.
2. **Supabase project** for Git2App (separate from Xpenstack's): project URL, anon key, and
   a service-role key stored only as a Worker secret.
3. **Cloudflare**: a Pages project for `apps/web`, a Workers deployment for `apps/api`, an
   R2 bucket, and a Queue. Account ID + API token (Workers/R2/Queues scopes).
4. **Apple Developer Program** membership + App Store Connect API key, and **Google Play**
   developer account + upload keystore — only when building *signed* store artifacts. For
   Xpenstack these already exist (see its `docs/setup/*.html`).
5. **macOS build capacity**: GitHub Actions macOS minutes, or a Codemagic token (free tier
   is what Xpenstack uses).

Until these exist, the platform runs in a **dry/unsigned** mode: analysis works fully,
Android debug/unsigned builds work, and iOS is scaffolded but not archived.
