# Git2App

Turns a GitHub-hosted web app or PWA into installable Android (APK/AAB) and iOS (IPA)
packages. First target: the Xpenstack PWA.

- Architecture, security and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Owner action items (accounts and keys only you can create): [docs/ARCHITECTURE.md §11](docs/ARCHITECTURE.md#11-owner-action-items)

## Quick start

```bash
nvm use            # Node 22.18+ (runs TypeScript directly, no build step)
npm install
npm test           # node --test, no test framework dependency
npm run typecheck

# Analyze any local checkout (add --root for a monorepo subfolder):
npm run analyze -- ../Xpenstack --origin https://app.xpenstack.com
```

## Layout

| Path | Purpose |
|---|---|
| `packages/shared` | Types, build state machine, log secret redaction |
| `packages/analyzer` | Deterministic repo analyzer and strategy engine |
| `packages/generator` | Capacitor / TWA project generation from a config |
| `packages/runner` | Build agent that runs inside an isolated worker |
| `apps/api` | Cloudflare Worker REST API |
| `apps/web` | React dashboard |
| `supabase/migrations` | Schema and row-level security |
| `infra/android-builder` | Pinned Linux Android build image |
