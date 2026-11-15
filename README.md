# Pinmap backend and place extraction test

This repository owns the server-side Pinmap code. The public web UI lives in
[`pinmap-web-prototype`](https://github.com/pinmap-team/pinmap-web-prototype),
and the separate mobile app lives in the private `pinmap` repository.

**[Open the online place extraction test](https://pinmap-backend.vercel.app/)** —
paste an Instagram post or reel URL and enter the test code to inspect extracted
places, map coordinates, review notes, and the raw server response.
After analysis, **핀맵 지도에서 보기** opens the official prototype in a new tab
and transfers the existing report to its development map. The test code stays
in the backend test tab and is never included in the link or transfer message.
The map button appears only when the report contains places; an empty result
still shows its server notes and raw response in the test screen.

## Modules

| Directory | Deployment | Purpose |
| --- | --- | --- |
| `api/` | Vercel | Validate test access, proxy Instagram links to Cloud Run, return browser-safe map and Supabase configuration. |
| `extractor/` | Google Cloud Run | Fetch public Instagram media, analyze captions and frames, extract places, and search map candidates. |
| `test-ui/` | Vercel static files | Login-free developer test screen with request status, extracted places, failures, and raw response. |
| `tests/`, `extractor/tests/` | CI/local | API boundary and place-search checks. |

## Request flow

1. The test screen sends an Instagram post/reel URL and test code to `POST /api/place-extract`.
2. The Vercel function validates the code and URL, then calls the Cloud Run `/extract-link` endpoint with a server-only token.
3. Cloud Run returns extracted places, coordinates, review flags, and source evidence. The test screen shows both the list and the raw JSON.
4. The Pinmap web UI may consume the same API through a same-origin Vercel rewrite after the backend deployment is configured.

## Setup and deployment

1. Link this repository to a Vercel project. Set the Vercel values described in `.env.example` in its environment settings. The extraction token and test code must remain server-only.
2. Deploy `extractor/` to Cloud Run from that directory's Dockerfile. Set `PINMAP_TEST_TOKEN` to the same value as Vercel's `PINMAP_EXTRACTOR_TOKEN`. Set the AI and map provider keys needed for the experiment in Cloud Run, not in Git.
3. Set `PINMAP_EXTRACTOR_ORIGIN` to the HTTPS Cloud Run origin. Keep Cloud Run's token check enabled.
4. Check `/api/map-config`, `/api/auth/config`, and one authorized `POST /api/place-extract` before switching the public web rewrite to this project.

The repository is private under the `pinmap-team` organization. Vercel Hobby does not support its native Git auto-deploy for an organization-owned private repository. Instead, `.github/workflows/deploy-vercel.yml` deploys the Vercel project after the `Backend tests` workflow succeeds on a push to `main`. It checks out the exact tested commit and uses Vercel CLI with a project-scoped GitHub Actions secret. The GitHub repository variables `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` identify the existing Vercel project; `VERCEL_TOKEN` is a repository secret. Configure all three before enabling this workflow. A failed test run does not deploy.

This workflow updates the Vercel API and development test screen. It does not redeploy the separate Cloud Run extractor. Keep `.vercel/` and local test access code files out of Git. If the workflow cannot run, deploy from a checkout with `vercel deploy --prod --scope stophyun02-projects` and inspect the failure in GitHub Actions.

No credentials, browser profiles, collected media, or generated results belong in Git. `.env.example` contains names only. Tests do not make paid AI or Places API requests.

Run `npm test` to check the API and Python lookup logic. Cloud Run's `GET /health` verifies that its process is running; it does not guarantee Instagram access or upstream AI availability.
