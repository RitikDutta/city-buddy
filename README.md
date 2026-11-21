# CityBuddy

CityBuddy is a local city assistant with a shopping checklist, contextual text conversations and a landmark guide. Choose a city, address, or landmark manually. The same browser profile keeps its checklist, location and conversation history in SQLite.

## Run locally

Use Node.js 22.13 or later and npm. With nvm, `nvm use` selects the project's Node 22 version. From the project directory, run the following commands. On an existing installation, keep your current `.env` file.

```bash
npm ci
cp -n .env.example .env
npm run dev
```

Open [CityBuddy on localhost](http://localhost:3000). The development command applies the checked-in Prisma migrations. The default database is `prisma/dev.db`. For a production build, run `npm run build` followed by `npm start`.

## Run with Docker

From the project directory, keep your existing `.env` and start the app with Docker Compose.

```bash
docker compose up --build -d
```

Open [CityBuddy on localhost](http://localhost:3000). On startup, the container applies pending Prisma migrations to its SQLite database in the `citybuddy-data` volume. The container starts with its own database. `docker compose down` keeps that volume.

Set `CITYBUDDY_PORT` in `.env` to use a different host port. Allow the resulting localhost origin in the Maps browser key restrictions. Rebuild the image after changing `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` or `NEXT_PUBLIC_GOOGLE_MAP_ID` so the browser bundle picks up the change.

## Connect Google services

| Environment variable | Purpose |
| --- | --- |
| `gemini_api_city_buddy` | Preferred server-side Gemini Developer API key from Google AI Studio. |
| `GEMINI_API_KEY` | Fallback server key when `gemini_api_city_buddy` is empty. |
| `GEMINI_MODEL` | Function-calling model. Defaults to `gemini-3.1-flash-lite`. |
| `google_map_api_city_buddy` | Preferred server key for Maps Experience agent tools. |
| `GOOGLE_MAPS_API_KEY` | Fallback server key when `google_map_api_city_buddy` is empty or Google denies it access to a Maps tool. |
| `GOOGLE_MAPS_MCP_URL` | Streamable HTTP endpoint, defaulting to `https://mapstools.googleapis.com/mcp`. |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Browser key for Maps JavaScript API. Apply a website restriction for the local app and an API restriction for Maps JavaScript API. |
| `GOOGLE_PLACES_API_KEY` | Optional server key for Places API (New). Enables structured address enrichment, ratings and opening hours. |
| `NEXT_PUBLIC_GOOGLE_MAP_ID` | Optional Google map ID for advanced markers. Local development defaults to Google’s demo map ID. |
| `DATABASE_URL` | SQLite connection URL. Relative paths resolve against the Prisma schema directory. |
| `NEXT_PUBLIC_APP_URL` | App origin used by the live verification script. Defaults to `http://localhost:3000`. |
| `DEMO_MODE` | Leave at `false` for the real-service MVP. Provider fixtures live in the test suite. |

Put keys in the git-ignored `.env` and restart the server. The **Connections** panel shows which keys are present. **Test MCP connection** discovers Google's tools and runs a small place search to verify access to search results. The checklist, history and session ending work independently of Google. A missing browser key leaves place cards, source links and directions available. [Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key) · [Maps Experience agent tools setup](https://developers.google.com/maps/ai/maps-experience-agent-tools) · [Maps JavaScript API setup](https://developers.google.com/maps/documentation/javascript/get-api-key)

## Use the three modes

- **My Items** supports quantities, notes, editing, purchase status and deletion. Switch to **Ask CityBuddy** to manage the same list conversationally or find shops.
- **Live Talk** searches around the selected location, remembers the order of earlier results and can route to a referenced destination. Ask in English, Hindi or Hinglish.
- **On-Site Guide** uses the manually selected landmark. Historical explanations use retrieved source material and acknowledge gaps. Use **End Session** or send **Stop**, **Exit**, **End session** or **Goodbye** to finish.

Select **Set Location** on the overview, or use the location control at the top of any page. Ambiguous queries offer candidates. Changing the selection updates geographic context in active sessions and keeps earlier messages available in session history.

## Implementation

- Next.js App Router serves both React screens and API handlers. The client uses `TextInputProvider` with a streamed progress channel. JSON is also supported by the message endpoint.
- `lib/server/maps.ts` connects with the official MCP SDK, sends the server key in the request header, pages through `tools/list` and validates each allowed tool call against the discovered JSON Schema. The health check uses a fresh connection. The optional Places adapter enriches previously identified places.
- `ManualLocationProvider` resolves names and Google Maps place links and obtains candidates with actual coordinates. Only server-issued candidates can be selected. Some MCP results supply a source title and coordinates without a structured address. In that case CityBuddy stores a null address and displays the source title. [Google’s place search fields](https://developers.google.com/maps/ai/maps-experience-agent-tools/search-places) · [Resolution API](https://developers.google.com/maps/ai/maps-experience-agent-tools/resolution-api)
- `lib/server/agent.ts` runs a bounded Gemini tool loop. It preserves full function-call parts, including thought signatures. Tool responses provide source titles, URLs, ordered places and route measurements. The UI renders supplied Google Maps attribution beside recommendations. [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling) · [Maps attribution](https://developers.google.com/maps/ai/maps-experience-agent-tools/attribution)
- `lib/server/repository.ts` owns persistence. A random HTTP-only identity cookie maps to a hashed credential. Each record is scoped to that user. Each active chat has a short turn lease. A completed turn commits the user message, assistant reply, map context and checklist edits in one transaction. The client request ID makes a retry of a completed turn idempotent.
- `public/art/` contains original WebP illustrations made with built-in ImageGen. The art briefs depict a parchment panorama of Hawa Mahal, a produce bazaar, a café terrace and a Rajasthani gateway. Live places and routes appear in the interactive map.

## HTTP API

| Method and path | Input or result |
| --- | --- |
| GET `/api/workspace` | Current identity, manual location, checklist, sessions and service configuration flags. |
| POST `/api/location/resolve` | Accepts `{ "query": "Mansarovar, Jaipur" }` and returns candidate places. |
| POST `/api/location/select` | Accepts a returned `place_id`. Saves it for the user and their active sessions. |
| GET / POST `/api/items` | List items or create one with a name and optional quantity, notes and status. |
| PATCH / DELETE `/api/items/:id` | Change supplied fields or remove an owned item. |
| POST `/api/sessions` | Accepts a mode. Opens or resumes that mode’s active session. |
| GET `/api/sessions/:id` | Ordered messages, source metadata, location and geographic context. |
| POST `/api/sessions/:id/messages` | Accepts `user_id`, `session_id`, `mode`, `message`, `location` and optional UUID `request_id`. Uses the saved location as authoritative. |
| POST `/api/sessions/:id/end` | Ends the session and retains its messages. |
| GET `/api/mcp/health` | Live tool discovery. Returns a service error for missing credentials, failed connectivity or missing required tools. |

Use `my_items`, `live_talk` or `on_site_guide` as the mode. Send the identity cookie returned by the workspace endpoint with subsequent requests. JSON clients receive the completed session. Clients that request `application/x-ndjson` receive progress events followed by a result or error.

## Verify

```bash
npm run typecheck
npm test
npm run build
npm run test:live
```

The automated suite uses a temporary SQLite database, a loopback MCP protocol server and scripted model turns. It exercises location selection, checklist CRUD, identity isolation, geographic follow-ups, route grounding, session ending, replay and transaction rollback.

Run the live check with the development server running and Google credentials configured. It exercises the eight requested workflows with an isolated test identity and makes real provider calls. If a required server key is absent, it runs the independent checks and exits with status 2 to identify incomplete live verification.
