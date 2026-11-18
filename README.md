# Pinmap content extraction backend

This repository owns the server-side Pinmap code. The public web UI lives in
[`pinmap-web-prototype`](https://github.com/pinmap-team/pinmap-web-prototype),
and the separate mobile app lives in the private `pinmap` repository.

**[Open the online extraction test](https://pinmap-backend.vercel.app/)** —
paste an Instagram post or reel URL and enter the test code to inspect extracted
places, event schedules, map coordinates, review notes, and the raw server response.
After analysis, **핀맵 지도에서 보기** opens the official prototype in a new tab
and transfers the existing report to its development map. The test code stays
in the backend test tab and is never included in the link or transfer message.
The map button appears only when the report contains places; an empty result
still shows its server notes and raw response in the test screen.

## Modules

| Directory | Deployment | Purpose |
| --- | --- | --- |
| `api/` | Vercel | Keep the developer test route, provide authenticated content extraction and account-backed save/list/delete routes, and return browser-safe map and Supabase configuration. |
| `extractor/` | Google Cloud Run | Fetch public Instagram media, analyze captions and frames, extract places and event dates separately, and search map candidates. |
| `test-ui/` | Vercel static files | Developer test screen with request status, places, event schedules, failures, and raw response. |
| `packages/multiuser/` | Separate opt-in Node service; excluded from Vercel | Account-isolated ZIP/media imports, persistent jobs, and audio/visual analysis retained from the earlier local backend. It is not connected to the public Pinmap UI. |
| `database/` | Apply to the official Supabase project | Atomic daily extraction quotas and per-account saved-content storage with server-only write permissions. |
| `tests/`, `extractor/tests/` | CI/local | API boundary, place-search, OCR, and event parsing checks. |

## Request flow

1. The developer test screen sends an Instagram post/reel URL, the test code, and `content_types: ["place", "event"]` to `POST /api/place-extract`. A shared server-side quota permits at most 20 developer analyses per Seoul calendar day. Existing callers that omit `content_types` retain place-only behavior.
2. The official route `POST /api/content-save` requires a Supabase user access token, checks the storage table, and claims one of five daily analysis attempts per user in Supabase before contacting Cloud Run. It defaults to both content types. `POST /api/content-extract` remains an authenticated extraction-only route with the same quota.
3. Vercel validates the URL and forwards the request to Cloud Run `/extract-link` using a server-only token. Cloud Run returns `places` and `map_locations` for map pins, plus independent `events` with dates, time text, venue, evidence, and review flags. Missing years or uncertain dates remain unstructured text for review.
4. The official save route stores a bounded, allowlisted report in the signed-in user's Supabase row using a server-only secret key. Browsers cannot write analysis fields directly to the database. `GET /api/content-save` restores saved items and `DELETE /api/content-save` removes an item. A failed analysis can save the link with `content_kind: "unknown"`; it does not replace an earlier successful report for the same link. The developer test screen can transfer a place report to the prototype map, but its test-code route does not persist results. The separate multiuser service has its own storage and authentication model.

## Instagram collection strategy

The Cloud Run extractor first uses Scrapling HTTP requests to parse the requested public photo post and downloads its full photo set with up to six concurrent transfers. Only matching post IDs, supported image-only media, and complete photo sets are accepted. Caption and media calls share a cache inside the same temporary request directory; results and browser sessions are never shared across users.

Unavailable public data, login restrictions, changed page structure, incomplete photos, unsupported/video posts, dependency errors, or image download failures automatically use the existing browser collector. Image downloads allow only HTTPS Instagram CDN hosts, validate file signatures, and retain the existing per-image and total size limits. Profile images are optional with a short timeout. The HTTP image target is 1080px for OCR; OCR, AI, map search, and saved-content behavior are unchanged.

Structured Cloud Run stderr records `stage=collection`, `method=scrapling_http` or `browser_fallback`, duration, and a bounded fallback category. It excludes captions, tokens, and signed image URLs. Set `PINMAP_SCRAPLING_ENABLED=0` on Cloud Run to use only the previous browser path. The pinned Scrapling dependency runs in the image's Python virtual environment. Vercel deployment alone does not enable this code; deploy `extractor/` to Cloud Run as well.

## Setup and deployment

1. Apply [`database/001_content_extraction_quota.sql`](database/001_content_extraction_quota.sql), [`database/002_saved_content.sql`](database/002_saved_content.sql), then [`database/003_developer_test_quota.sql`](database/003_developer_test_quota.sql) to the same Supabase project named by `SUPABASE_URL`. Record each applied migration; these files are intended to run once, in order. Until the required functions and table are available, the routes return `503` without contacting the extractor. The saved-content table has a 100-item account limit. Only the backend can write analysis rows; authenticated users may read only their own rows through the backend.
2. Deploy `extractor/` to Cloud Run from its Dockerfile. Set `PINMAP_TEST_TOKEN` to the same server-only value as Vercel's `PINMAP_EXTRACTOR_TOKEN`. Supply the AI and map provider keys in Cloud Run, not Git. Deploy and verify the Cloud Run revision separately; Vercel's Git deployment does not update it.
3. Link this repository to the Vercel project and set the Vercel values described in `.env.example`. `SUPABASE_PUBLISHABLE_KEY` is public by design. Set `SUPABASE_SECRET_KEY` (`sb_secret_…`) as a **server-only** Vercel environment variable before deploying the new routes; never put it in the browser, Git, a URL, or a chat. Keep the extractor token only on servers; configure the developer test code in Vercel and enter it in the test form, never in Git or a public link.
4. Verify `GET /health` on Cloud Run, `GET /api/map-config`, `GET /api/auth/config`, an authorized developer `POST /api/place-extract`, and authenticated `POST`, `GET`, and `DELETE` requests to `/api/content-save` through the public web's same-origin rewrites. Confirm that a second account cannot read the first account's rows, cannot write a forged analysis record directly to Supabase, and that the developer test quota is enforced. Check an event with a partial date and a place with ambiguous coordinates; neither should gain an invented date or pin.

Official API request: `POST /api/content-extract` with `Authorization: Bearer <Supabase user access token>`, `Content-Type: application/json`, and body `{"url":"https://www.instagram.com/p/.../","content_types":["place","event"]}`. The response keeps `results[0].places` and `results[0].map_locations` and adds `results[0].events` and `results[0].content_kind`. Use `event_type` (`exhibition`, `pop_up`, `other`), `start_date`, `end_date`, `date_text`, `time_text`, `venue_name`, `address`, `evidence`, `needs_review`, and `notes` on each event. Treat map coordinates and event dates marked for review as candidates, not verified facts.

Official save API: `POST /api/content-save` uses the same bearer token and request body and returns `{item, analysis_status, analysis_notes, warnings}`. `GET /api/content-save?limit=2&offset=0` returns `{items, next_offset}`; both parameters are optional, and each page contains at most two items so embedded image data stays below the function response limit. `DELETE /api/content-save` takes `{"url":"https://www.instagram.com/p/.../"}` and returns `{deleted}`. Extraction errors consume an attempt after the quota claim, and the link can still be saved with a review status. The database stores neither the original video nor full captions or OCR output. Profile, cover, and place thumbnails have explicit size limits; an omitted thumbnail appears in `warnings`. A signed-in browser receives only the public Supabase key; the backend independently verifies its access token before using the secret key for storage.

This repository is public under `pinmap-team` and is directly connected to the existing `pinmap-backend` Vercel project. A push to `main` deploys the Vercel API and development test screen; pull requests receive preview deployments. The `Backend tests` GitHub workflow checks code, but Vercel's native Git deployment does not wait for that workflow to pass. Keep the Vercel project's Git Fork Protection enabled because preview environments contain server-only test credentials.

Vercel Git deployment does not redeploy the separate Cloud Run extractor. Keep `.vercel/` and local test access code files out of Git. If deployment fails, inspect the project's Vercel deployment logs and the GitHub test result before making another change.

The earlier local AI backend is kept under `packages/multiuser/` as a separate
service. Its own API, SQLite store, and worker do not share the Vercel routes or
the official site's authentication. `.vercelignore` keeps this source out of
the Vercel deployment; the CI workflow runs its tests separately. See the
package README before running it. Public Instagram links and map candidate
resolution use this repository's Cloud Run extractor rather than a second
local copy of that pipeline. No historical user export or local database is
included in the package.

No credentials, browser profiles, collected media, or generated results belong in Git. `.env.example` contains names only. Tests do not make paid AI or Places API requests.

Run `npm test` to check the API and Python lookup logic. Cloud Run's `GET /health` verifies that its process is running; it does not guarantee Instagram access or upstream AI availability.
