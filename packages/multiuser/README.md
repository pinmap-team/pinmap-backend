# Optional multiuser analysis service

This package preserves the distinct account, Instagram export, media upload,
queued analysis, and audio transcription work from the former local AI backend.
It runs as a **separate Node service**. The repository root Vercel project and
its public place-extraction test do not serve these routes or store this
package's SQLite data. This package is not deployed by the root Vercel workflow.

## What it owns

| Part | Responsibility |
| --- | --- |
| `service/api.mjs` | Account sessions, per-user posts, Instagram ZIP/JSON import, media uploads, job/result retrieval. |
| `service/db.mjs`, `service/jobs.mjs` | SQLite persistence, deduplication, per-user job queue and worker leases. |
| `service/worker.mjs` | Analyze user-supplied media with the selected vision provider; transcribe audio when configured. |
| `service/extractor-client.mjs` | Use the shared Cloud Run extractor for public Instagram links, place matching, and event schedules. |
| `service/migrate-legacy.mjs` | Optional one-time import from a user-supplied older local catalog. |

Public-link collection, event schedule extraction, and place-name search are delegated to the existing
Cloud Run extractor. Event schedules remain separate from map locations in each job result.
Its Instagram access and upstream AI/Places availability
still determine whether a particular link can be analyzed. The module's own
vision providers (`gemini`, `ollama`, `vllm`) remain for uploaded photos and
videos; ASR is configured separately for videos with audio. The old one-user
web screen and its separate Instagram collector were not imported.

## Local run

Use Node.js 22 or later. From this directory:

```sh
npm ci
cp .env.multiuser.example .env
npm start
```

Set the placeholders in `.env` before accepting user requests. Run
`npm run worker` in another terminal for queued jobs. `npm run start:local`
starts an API and worker together on `127.0.0.1` without account sign-in for
local development; it must remain bound to the loopback interface. It serves
a web app only if `PINMAP_FRONTEND_DIR` points to an explicit local build.

If a media analysis provider rejects a request with 401, 403, or 429, the
worker records a persistent pause for that provider and leaves its remaining
jobs queued. A missing provider configuration pauses the same way. An ASR
authorization or quota error pauses all uploaded-media analysis. Public-link
jobs continue through the shared extractor. Check the pause with
`npm run queue -- status`; after correcting the provider's key or limit,
explicitly resume it with `npm run queue -- resume <provider>` (or
`all_media` for an ASR pause). Failed and interrupted jobs are never retried
automatically. Already-running requests cannot be recalled by this pause.

The shared extractor requires `PINMAP_EXTRACTOR_ORIGIN` on the API and worker,
plus `PINMAP_EXTRACTOR_TOKEN` on the worker. Use the same server-only token as
the root Vercel backend. Never place it in browser code. The API's invite
code, provider keys and optional ASR settings are listed in
`.env.multiuser.example`.

`npm test` runs the package checks against generated synthetic Instagram
records. It does not call live AI or Places services. The original person's
Instagram export, local SQLite databases, model files, credentials, generated
media, and job results are not part of this repository.

## Deployment boundary

The Docker/Compose files in this directory describe an independent service
with a persistent `pinmap_data` volume and a separate worker. Deploying the
root Vercel project does not start it. Its SQLite account/session model is
separate from the public prototype's Supabase configuration, so connecting a
user-facing app to these routes requires an explicit authentication and data
migration decision.

For a one-time import from the old local catalog, point `SOURCE_ROOT` at the
user-owned `pinmap-items.json` source and run
`npm run migrate:legacy -- user@example.com` after creating that account.
That source and the old `.data-ollama` directory stay outside Git.

Daily analysis counts are not limited by this service. The per-account queue capacity and worker concurrency remain independent controls; upstream provider quota pauses are still handled by the existing queue logic. `MULTIUSER_DAILY_JOB_LIMIT` is no longer read.
