// Deterministic provider fixtures. These modules are never imported by the application.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Content } from "@google/genai";
import type { Incoming, Session } from "../lib/contracts";
import type { ChatModel } from "../lib/server/agent";
import { ManualLocationProvider } from "../lib/server/location";
import { openMaps } from "../lib/server/maps";
import { rateLimitWait } from "../lib/server/errors";
import { resultPayload, parsePlace } from "../lib/server/map-results";

const dir = mkdtempSync(join(tmpdir(), "citybuddy-test-"));
const database = join(dir, "test.db");
const key = "fixture-key";
const requests: { name: string; args: Record<string, any> }[] = [];
const tools = [
  {
    name: "search_places",
    inputSchema: {
      type: "object",
      properties: {
        textQuery: { type: "string" },
        locationBias: { type: "object" },
      },
      required: ["textQuery"],
      additionalProperties: false,
    },
  },
  {
    name: "compute_routes",
    inputSchema: {
      type: "object",
      $defs: {
        Waypoint: {
          type: "object",
          properties: { placeId: { type: "string" } },
          required: ["placeId"],
          additionalProperties: false,
        },
      },
      properties: {
        origin: { $ref: "#/$defs/Waypoint" },
        destination: { $ref: "#/$defs/Waypoint" },
        travelMode: { type: "string" },
        includePolyline: { type: "boolean" },
      },
      required: ["origin", "destination", "travelMode"],
      additionalProperties: false,
    },
  },
  {
    name: "resolve_names",
    inputSchema: {
      type: "object",
      properties: { queries: { type: "array" } },
      required: ["queries"],
      additionalProperties: false,
    },
  },
  {
    name: "resolve_maps_urls",
    inputSchema: {
      type: "object",
      properties: { urls: { type: "array" } },
      required: ["urls"],
      additionalProperties: false,
    },
  },
  {
    name: "unrelated_fixture_tool",
    inputSchema: { type: "object", properties: {} },
  },
];
const fixturePlace = (
  id: string,
  title: string,
  latitude: number,
  longitude: number,
) => ({
  id,
  place: "places/" + id,
  location: { latitude, longitude },
  attribution: {
    title,
    url:
      "https://www.google.com/maps/search/?api=1&query=" +
      encodeURIComponent(title),
  },
  googleMapsLinks: {
    placeUrl:
      "https://www.google.com/maps/search/?api=1&query=" +
      encodeURIComponent(title),
  },
});
const home = fixturePlace("fixture-home", "Mansarovar, Jaipur", 26.86, 75.76);
const landmark = fixturePlace(
  "fixture-landmark",
  "Hawa Mahal, Jaipur",
  26.92,
  75.82,
);
const first = fixturePlace("fixture-first", "Fixture museum", 26.91, 75.8);
const second = fixturePlace("fixture-second", "Fixture gallery", 26.9, 75.83);
const homeSummary = "Mansarovar is a neighbourhood in southern Jaipur.";
const landmarkHistory = "Hawa Mahal was completed in 1799.";
function reply(name: string, args: Record<string, any>) {
  if (name === "resolve_names")
    return {
      results: [
        {
          entity: {
            place:
              "places/" +
              (String(args.queries[0].text).includes("Hawa")
                ? landmark.id
                : home.id),
          },
        },
      ],
    };
  if (name === "resolve_maps_urls")
    return { entities: [{ place: "places/" + landmark.id }] };
  if (name === "compute_routes")
    return {
      routes: [
        {
          distanceMeters: 760,
          duration: "570s",
          attribution: {
            title: "Fixture walking route",
            url: "https://www.google.com/maps/dir/",
          },
        },
      ],
    };
  const query = String(args.textQuery);
  const places = query.includes("ambiguous")
    ? [home, landmark]
    : /tourist|store|caf[eé]|attraction|shops/i.test(query)
      ? [first, second]
      : /Hawa|fixture-landmark/.test(query)
        ? [landmark]
        : [home];
  return {
    summary: places
      .map((p, i) => {
        const text =
          p === home
            ? homeSummary
            : p === landmark
              ? landmarkHistory
              : p.attribution.title;
        return text + " [" + i + "]";
      })
      .join("\n"),
    places,
  };
}
let server: Server;
let repo: typeof import("../lib/server/repository").repository;
let run: typeof import("../lib/server/agent").runTurn;
let db: typeof import("../lib/server/db").db;
let host: string;
before(async () => {
  process.env.DATABASE_URL = "file:" + database;
  process.env.GOOGLE_MAPS_API_KEY = key;
  process.env.google_map_api_city_buddy = "";
  delete process.env.GOOGLE_PLACES_API_KEY;
  const sqlite = new DatabaseSync(database);
  sqlite.exec(
    readFileSync("prisma/migrations/20261120000000_init/migration.sql", "utf8"),
  );
  sqlite.close();
  ({ repository: repo } = await import("../lib/server/repository"));
  ({ db } = await import("../lib/server/db"));
  ({ runTurn: run } = await import("../lib/server/agent"));
  server = createServer(async (req, res) => {
    if (req.headers["x-goog-api-key"] !== key) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const call = JSON.parse(Buffer.concat(chunks).toString());
    if (!("id" in call)) {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (call.method === "initialize")
      result = {
        protocolVersion: call.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "citybuddy-fixture", version: "1" },
      };
    if (call.method === "tools/list")
      result = call.params?.cursor
        ? { tools: tools.slice(2) }
        : { tools: tools.slice(0, 2), nextCursor: "second-page" };
    if (call.method === "tools/call") {
      const { name, arguments: args } = call.params;
      requests.push({ name, args });
      const value = reply(name, args);
      result = {
        structuredContent: value,
        content: [{ type: "text", text: JSON.stringify(value) }],
      };
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  host = "http://127.0.0.1:" + addr.port + "/mcp";
  process.env.GOOGLE_MAPS_MCP_URL = host;
});
after(async () => {
  await db?.$disconnect();
  if (server?.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});
function script(
  ...steps: (Content | ((history: Content[]) => Content))[]
): ChatModel {
  return {
    async next(history, _guide, declarations) {
      assert.ok(!declarations.some((d) => d.name === "unrelated_fixture_tool"));
      const step = steps.shift();
      assert.ok(step, "Unexpected extra model invocation");
      return typeof step === "function" ? step(history) : step;
    },
  };
}
const call = (name: string, args: Record<string, unknown> = {}): Content => ({
  role: "model",
  parts: [
    { functionCall: { name, args }, thoughtSignature: "fixture-signature" },
  ],
});
const say = (text: string): Content => ({ role: "model", parts: [{ text }] });
function input(user: string, session: Session, message: string): Incoming {
  return {
    user_id: user,
    session_id: session.id,
    mode: session.mode,
    message,
    location: session.location,
    request_id: randomUUID(),
  };
}
async function withLocation(query = "Mansarovar, Jaipur") {
  const identity = await repo.identity();
  const choices = await new ManualLocationProvider().resolve(query);
  await repo.rememberChoices(identity.user.id, choices);
  const loc = await repo.selectLocation(identity.user.id, choices[0].place_id);
  return { user: identity.user.id, loc };
}
test("MCP discovers paginated tools, validates inputs, prefers structured output, and honors a real HTTP failure", async () => {
  const client = await openMaps();
  try {
    assert.equal(client.tools.length, 5);
    await assert.rejects(
      client.call("unrelated_fixture_tool", {}),
      /arguments/,
    );
    await assert.rejects(
      client.call("search_places", { text_query: 42 }),
      /arguments/,
    );
    const value = await client.call("search_places", {
      text_query: "Mansarovar, Jaipur",
    });
    assert.equal(value.places[0].name, home.attribution.title);
    assert.equal(value.places[0].formatted_address, null);
    assert.equal(value.sources[0].url, home.attribution.url);
  } finally {
    await client.close();
  }
  assert.deepEqual(
    resultPayload({
      structuredContent: { summary: "source" },
      content: [{ type: "text", text: '{"summary":"other"}' }],
    }),
    { summary: "source" },
  );
  assert.deepEqual(
    resultPayload({
      content: [{ type: "text", text: '{"summary":"fallback"}' }],
    }),
    { summary: "fallback" },
  );
  assert.equal(
    parsePlace({ ...home, location: { latitude: 102, longitude: 75 } })
      ?.latitude,
    null,
  );
  assert.throws(
    () => resultPayload({ isError: true, content: [] }),
    /rejected/,
  );
  const old = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "invalid";
  try {
    await assert.rejects(openMaps(), /credentials|could not/);
    process.env.google_map_api_city_buddy = key;
    const preferred = await openMaps();
    try {
      const result = await preferred.call("search_places", {
        textQuery: "Jaipur",
      });
      assert.equal(result.places[0].place_id, home.id);
    } finally {
      await preferred.close();
    }
  } finally {
    process.env.google_map_api_city_buddy = "";
    process.env.GOOGLE_MAPS_API_KEY = old;
  }
});
test("manual resolution offers ambiguity, verifies the chosen ID and scopes candidates to one identity", async () => {
  const a = await repo.identity();
  const b = await repo.identity();
  assert.equal((await repo.identity(a.token!)).user.id, a.user.id);
  assert.notEqual((await repo.identity(a.user.id)).user.id, a.user.id);
  const provider = new ManualLocationProvider();
  const choices = await provider.resolve("ambiguous Jaipur");
  assert.equal(choices.length, 2);
  await repo.rememberChoices(a.user.id, choices);
  await assert.rejects(
    repo.selectLocation(b.user.id, choices[1].place_id),
    /Search/,
  );
  await assert.rejects(repo.selectLocation(a.user.id, "invented"), /Search/);
  const selected = await repo.selectLocation(a.user.id, choices[1].place_id);
  assert.equal(selected.source, "manual");
  assert.equal(selected.latitude, landmark.location.latitude);
  assert.equal(
    (await provider.resolve("https://maps.app.goo.gl/fixture"))[0].place_id,
    landmark.id,
  );
  await assert.rejects(
    provider.resolve("https://example.com/not-a-map"),
    /Google Maps/,
  );
});
test("shopping memory persists across reads, supports every editor action and isolates users", async () => {
  const a = await repo.identity();
  const b = await repo.identity();
  const item = await repo.addItem(a.user.id, {
    name: "Laptop charger",
    quantity: 2,
    notes: "USB-C",
  });
  assert.equal(
    (await repo.listItems((await repo.identity(a.token!)).user.id))[0].id,
    item.id,
  );
  await assert.rejects(
    repo.editItem(b.user.id, item.id, { status: "purchased" }),
    /found/,
  );
  await assert.rejects(repo.removeItem(b.user.id, item.id), /found/);
  assert.equal(
    (
      await repo.editItem(a.user.id, item.id, {
        status: "purchased",
        name: "Travel charger",
      })
    ).status,
    "purchased",
  );
  assert.equal(
    (await repo.editItem(a.user.id, item.id, { status: "pending" })).name,
    "Travel charger",
  );
  await repo.removeItem(a.user.id, item.id);
  assert.equal((await repo.listItems(a.user.id)).length, 0);
});
test("item tool reads, store search at the selected origin, completed mutation and replay", async () => {
  const { user, loc } = await withLocation();
  const item = await repo.addItem(user, { name: "Laptop charger" });
  let session = await repo.openSession(user, "my_items");
  session = await run(user, input(user, session, "What items are pending?"), {
    model: script(call("get_items"), (history) => {
      assert.ok(JSON.stringify(history.at(-1)).includes(item.id));
      assert.ok(JSON.stringify(history).includes("fixture-signature"));
      return say("Laptop charger is pending.");
    }),
  });
  const task = input(user, session, "Where can I buy my charger nearby?");
  session = await run(user, task, {
    model: script(
      call("get_items"),
      call("search_places", { text_query: "electronics stores" }),
      say("Here are the stores."),
    ),
  });
  assert.deepEqual(session.messages.at(-1)?.metadata?.tools, [
    "get_items",
    "search_places",
  ]);
  const search = requests.filter((r) => r.name === "search_places").at(-1)!;
  assert.deepEqual(search.args.locationBias.circle.center, {
    latitude: loc.latitude,
    longitude: loc.longitude,
  });
  const changed = input(user, session, "I purchased the charger.");
  await run(user, changed, {
    model: script(
      call("get_items"),
      call("update_item", { id: item.id, changes: { status: "purchased" } }),
      say("Marked purchased."),
    ),
  });
  assert.equal((await repo.listItems(user))[0].status, "purchased");
  const replay = await run(user, changed, { model: script() });
  assert.equal(replay.messages.length, 6);
  const other = (await repo.identity()).user.id;
  await assert.rejects(run(other, changed, { model: script() }), /found/);
});
test("ordinal follow-up survives reopening, routes use verified endpoints, and a destination anchors the next search", async () => {
  const { user, loc } = await withLocation();
  let session = await repo.openSession(user, "live_talk");
  session = await run(
    user,
    input(user, session, "Show nearby tourist places."),
    {
      model: script(
        call("search_places", { text_query: "tourist attractions" }),
        say("1. Fixture museum\n2. Fixture gallery"),
      ),
    },
  );
  session = await repo.session(user, session.id);
  assert.deepEqual(
    session.context.places.map((p) => p.place_id),
    [first.id, second.id],
  );
  session = await run(
    user,
    input(user, session, "Tell me about the second one."),
    {
      model: script(
        call("focus_place", { place_id: second.id }),
        say("The second place is Fixture gallery."),
      ),
    },
  );
  assert.equal(session.context.focus?.place_id, second.id);
  session = await run(
    user,
    input(user, session, "How long will it take to walk there?"),
    {
      model: script(
        call("compute_routes", {
          origin: { place_id: loc.place_id },
          destination: { place_id: second.id },
          travel_mode: "WALK",
        }),
        say("About 10 minutes."),
      ),
    },
  );
  assert.equal(session.context.routes[0].duration_seconds, 570);
  const route = requests.filter((r) => r.name === "compute_routes").at(-1)!;
  assert.deepEqual(route.args.destination, { placeId: second.id });
  assert.equal(route.args.includePolyline, true);
  assert.match(session.context.routes[0].navigation_url!, /travelmode=walking/);
  await run(
    user,
    input(user, session, "Are there cafés around that location?"),
    {
      model: script(
        call("search_places", {
          text_query: "cafés",
          anchor_place_id: second.id,
        }),
        say("Here are the nearby places."),
      ),
    },
  );
  const search = requests.filter((r) => r.name === "search_places").at(-1)!;
  assert.deepEqual(search.args.locationBias.circle.center, second.location);
});
test("changing location resets geographic references, preserves chat/list, and Stop closes the session", async () => {
  const { user } = await withLocation();
  const item = await repo.addItem(user, { name: "Notebook" });
  let session = await repo.openSession(user, "on_site_guide");
  session = await run(user, input(user, session, "Tell me about this place."), {
    model: script(
      call("search_places", { text_query: "Mansarovar" }),
      say("A fictional king built it in 9999."),
    ),
  });
  const overview = session.messages.at(-1)!;
  assert.equal(overview.content, homeSummary);
  assert.equal(overview.metadata?.suggestion, "Show me nearby landmarks.");
  assert.ok(
    overview.metadata?.sources.some(
      ({ title }) => title === home.attribution.title,
    ),
  );
  const choices = await new ManualLocationProvider().resolve(
    "Hawa Mahal, Jaipur",
  );
  await repo.rememberChoices(user, choices);
  await repo.selectLocation(user, landmark.id);
  session = await repo.session(user, session.id);
  assert.equal(session.location!.place_id, landmark.id);
  assert.equal(session.context.places.length, 0);
  assert.equal(session.messages.length, 2);
  session = await run(user, input(user, session, "What else is nearby?"), {
    model: script(
      call("search_places", { text_query: "attractions" }),
      say("Here are nearby attractions."),
    ),
  });
  session = await run(user, input(user, session, "Stop"));
  assert.equal(session.status, "ended");
  assert.equal((await repo.listItems(user))[0].id, item.id);
  await assert.rejects(
    run(user, input(user, session, "More"), { model: script() }),
    /ended/,
  );
  assert.notEqual(
    (await repo.openSession(user, "on_site_guide")).id,
    session.id,
  );
});
test("the guide preserves cited history and stores the next prompt separately from the answer", async () => {
  const { user } = await withLocation();
  let session = await repo.openSession(user, "on_site_guide");
  session = await run(user, input(user, session, "What is its history?"), {
    model: script(
      call("search_places", { textQuery: "Mansarovar" }),
      say("A fictional king built it in 9999."),
    ),
  });
  assert.match(session.messages.at(-1)!.content, /sources don’t verify/);
  assert.doesNotMatch(session.messages.at(-1)!.content, /9999/);
  assert.equal(
    session.messages.at(-1)!.metadata?.suggestion,
    "Show me nearby landmarks.",
  );

  const choices = await new ManualLocationProvider().resolve(
    "Hawa Mahal, Jaipur",
  );
  await repo.rememberChoices(user, choices);
  await repo.selectLocation(user, landmark.id);
  session = await repo.session(user, session.id);
  session = await run(user, input(user, session, "Tell me about this place."), {
    model: script(
      call("search_places", { textQuery: "Hawa Mahal" }),
      call("cite_history", { place_id: landmark.id, excerpt: landmarkHistory }),
      say(landmarkHistory + "\n\nNext prompt: What can I visit nearby?"),
    ),
  });
  const answer = session.messages.at(-1)!;
  assert.equal(answer.content, landmarkHistory);
  assert.equal(answer.metadata?.history_excerpt, landmarkHistory);
  assert.equal(answer.metadata?.suggestion, "What can I visit nearby?");
});
test("failed or interrupted turns roll back staged writes and concurrent sends cannot interleave", async () => {
  const quotaError = (quotaId: string) => ({
    status: 429,
    message: JSON.stringify({
      error: {
        details: [
          { retryDelay: "12.2s" },
          { violations: [{ quotaId, quotaValue: "10" }] },
        ],
      },
    }),
  });
  assert.equal(rateLimitWait(quotaError("RequestsPerMinute")), 14);
  assert.equal(rateLimitWait(quotaError("RequestsPerDay")), undefined);
  const user = (await repo.identity()).user.id;
  const session = await repo.openSession(user, "my_items");
  await assert.rejects(
    run(user, input(user, session, "Add milk"), {
      model: script(call("add_item", { name: "Milk" }), () => {
        throw new Error("simulated timeout");
      }),
    }),
    /timeout/,
  );
  assert.equal((await repo.listItems(user)).length, 0);
  assert.equal((await repo.session(user, session.id)).messages.length, 0);
  await repo.acquire(user, session.id, "fixture-lease");
  await assert.rejects(
    run(user, input(user, session, "Add milk"), { model: script() }),
    /busy/,
  );
  await repo.release(user, session.id, "fixture-lease");
  const req = input(user, session, "Add milk");
  await run(user, req, {
    model: script(call("add_item", { name: "Milk" }), say("Added milk.")),
  });
  await run(user, req, { model: script() });
  assert.equal((await repo.listItems(user)).length, 1);
});
