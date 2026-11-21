# CityBuddy

CityBuddy is a text-based city assistant. It keeps your manual location, checklist, chat sessions, preferences and itineraries in SQLite. The default setup searches an included Jaipur catalog and plans outings locally.

## Run locally

Use Node.js 22.13 or later and npm. Run `nvm use` if you use nvm. Keep your existing root `.env` when upgrading.

```bash
npm ci
cp -n .env.example .env
npm run db:setup
npm run dev
```

Open [CityBuddy](http://localhost:3000) or the [outing planner](http://localhost:3000/outing). The same Next.js process serves the web app and the [workspace API](http://localhost:3000/api/workspace). The API reference is [below](#http-api). Development startup also applies pending migrations. For production, run `npm run build` and `npm start`.

Start by setting **Jaipur** or **Hawa Mahal** as your location. You can also enter latitude and longitude. Open **Outing planner** to set your travel mode, time window and interests, select stops, and create a plan. Then use the planner or chat to say “Skip the next place,” “I already visited this,” or “I only have one hour left.” The development simulator supports coordinates, map selection and arrival at a scheduled stop.

**My Items** supports quantities, notes and pending, purchased or skipped status. **Live Talk** searches around the selected location and remembers results for follow-ups. **On-Site Guide** shows sourced descriptions where the catalog supplies them. Click a chat suggestion to put its text in the composer. Send “Stop” or use **End session** to close a conversation while keeping its history. Use the same browser profile to resume your saved state.

## Configuration

Use a single root `.env`. The default configuration requires no provider credentials.

| Variable | Default or purpose |
| --- | --- |
| `DATABASE_URL` | `file:./dev.db`. Relative to the Prisma schema directory. Compose sets a path in its data volume. |
| `CITYBUDDY_ALLOW_METERED` | `0`. Set to `1` only when you explicitly approve use of the configured Google services and any resulting charges. |
| `CITYBUDDY_WORKER` | Enabled by default. Set to `0` to disable the prepared-context worker. |
| `CITYBUDDY_SIMULATOR` | `0`. The simulator panel is visible in development. Set to `1` to expose it in production. |
| `CITYBUDDY_TIME_ZONE` | `Asia/Kolkata`. Used for time-of-day chat and preparation. |
| `CITYBUDDY_PLACE_CATALOG` | Optional path to an additional local JSON catalog. |
| `CITYBUDDY_PORT` | `3000`. Optional Compose host port. |
| `gemini_api_city_buddy`, `GEMINI_API_KEY` | Optional Gemini server key and fallback. |
| `GEMINI_MODEL` | Optional Gemini model selection. Defaults to `gemini-3.1-flash-lite`. |
| `google_map_api_city_buddy`, `GOOGLE_MAPS_API_KEY` | Optional Maps Experience server key and fallback. |
| `GOOGLE_MAPS_MCP_URL` | Optional Maps Experience endpoint override. |
| `GOOGLE_PLACES_API_KEY` | Optional Places API key for verified details. |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, `NEXT_PUBLIC_GOOGLE_MAP_ID` | Optional browser map credentials. Apply HTTP referrer and Maps JavaScript API restrictions to the browser key. |
| `NEXT_PUBLIC_APP_URL` | Base URL for the optional provider smoke test. Defaults to `http://localhost:3000`. |

Connections shows which keys are present and whether their providers are enabled. Restart CityBuddy after updating `.env`. After explicit opt-in, the existing Google adapters support broader place searches, route evidence, map links and optional Gemini chat. The map uses the local view while Google loads and if Google is unavailable. The planner and the background worker still use the local catalog. See the [Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key), [Maps Experience agent tools](https://developers.google.com/maps/ai/maps-experience-agent-tools), and [Maps JavaScript API keys](https://developers.google.com/maps/documentation/javascript/get-api-key) documentation.

## Run with Docker

```bash
docker compose up --build -d
```

Open [CityBuddy](http://localhost:3000). Compose passes settings from the root `.env` to the container. Its startup command migrates the SQLite database in the `citybuddy-data` volume. The earlier `ritikdutta/citybuddy:tagname` image predates this refactor. Build from this checkout to run these changes.

## Data and estimates

The included catalog contains 444 mapped places and localities in Jaipur, including six landmark descriptions sourced from Rajasthan Tourism. Local place names, coordinates, categories and the bundled street and water layer come from OpenStreetMap extracts. Place cards link to source records. [OpenStreetMap contributors and ODbL](https://www.openstreetmap.org/copyright) · [Rajasthan Tourism Jaipur guide](https://www.tourism.rajasthan.gov.in/jaipur.html)

Extend coverage by importing your own Overpass JSON exports. Include node coordinates or request centers for ways and relations. The importer runs on local files.

```bash
npm run places:import -- ./additional-places.json ./overpass-export.json
```

Set `CITYBUDDY_PLACE_CATALOG` to the output path and restart. For Compose, bind-mount that file through an override and use its container path. Keep source attribution with the data.

Local name lookup depends on the installed catalog. Coordinates work anywhere, with empty nearby results outside covered areas. The offline map plots available points. Distance follow-ups use the selected location and the coordinates of a known place and identify the result as straight-line distance. The planner uses straight-line distances, a detour allowance and typical travel speeds. Stock, opening hours, prices, ratings, accessibility, road routes and traffic are unverified unless a configured provider returns them. A saved budget is a planning preference. The planner labels partial plans and records constraints it could not meet. Chat matches English, Latin-script Hinglish and Devanagari Hindi turn by turn. The optional Gemini path handles broader phrasing.

## HTTP API

JSON requests can use the HTTP-only identity cookie from `GET /api/workspace`. A new browser profile starts with its own state.

| Method and path | Input or result |
| --- | --- |
| GET `/api/workspace` | Current identity, location, checklist, sessions and provider flags. |
| POST `/api/location/resolve` | Accepts a `query` such as `Hawa Mahal, Jaipur` or `26.9239, 75.8267`. |
| PATCH `/api/location` | Accepts a returned `place_id`, latitude and longitude with optional name, or `{ "clear": true }`. |
| POST `/api/location/select` | Compatibility endpoint for selecting a server-issued candidate. |
| POST `/api/location/simulate` | Accepts coordinates or an owned `tripId` and `stopId`. |
| GET / POST `/api/items` | List or create checklist items. Include an optional UUID `requestId` to deduplicate a retry. |
| PATCH / DELETE `/api/items/:id` | Update or remove an owned checklist item. |
| POST `/api/sessions` | Open or resume `my_items`, `live_talk` or `on_site_guide`. |
| GET `/api/sessions/:id` | Ordered messages, structured results, location and geographic context. |
| POST `/api/chat`, `/api/sessions/:id/messages` | Accepts `user_id`, `session_id`, `mode`, `location`, `message` and an optional UUID `request_id`. The session message endpoint supports streamed NDJSON progress. |
| POST `/api/sessions/:id/end` | End a conversation and retain its history. |
| GET `/api/places/nearby` | Filters include `q`, repeated `category`, `radius` in meters, `limit` and `explore=1`. Returns applied radii and ranked results. |
| GET `/api/places/details` | Looks up a catalog entry using the `id` query parameter. |
| GET / PATCH `/api/preferences` | Read or update travel mode, available minutes, maximum distance and interests. |
| POST `/api/trips/plan` | Accepts a UUID `requestId`, `constraints` and optional `sessionId`. |
| GET `/api/trips/active`, `/api/trips/:id` | Read the active or an owned saved itinerary. |
| POST `/api/trips/:id/replan` | Accepts the current `version`, an `action` and any applicable `stopId` or `remainingMinutes`. |
| GET / POST `/api/recommendations` | Get ranked exploration results or record a `shown` or `dismissed` event. |
| GET / POST `/api/outing` | Read planning and preparation state or request a preparation job. |
| GET / DELETE `/api/jobs/:id` | Read the status of a job or cancel it. |
| GET `/api/metrics` | Development-only process counters and timing aggregates. |
| GET `/api/mcp/health` | Optional live provider discovery after metered opt-in. |

Request types for planning, discovery and preferences are in [`lib/outing-contracts.ts`](lib/outing-contracts.ts). Stale itinerary revisions return HTTP 409. The chat request ID and trip request ID let clients retry without duplicating persisted results.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

With the app running in local mode, run `npm run test:offline`. It creates a fresh identity, exercises eight workflows through the HTTP API and checks stored state. Use `CITYBUDDY_TEST_URL` to target a different loopback origin. The unit and integration suite uses temporary SQLite databases and loopback mock providers. Run `npm run test:live` only after explicitly approving metered calls and setting `CITYBUDDY_ALLOW_METERED=1`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the audit, migration and module boundaries.
