import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const base = new URL(process.env.CITYBUDDY_TEST_URL || "http://localhost:3000");
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname),
  "The offline test requires a loopback server.",
);

function client(identity) {
  let cookie = identity;
  return {
    identity: () => cookie,
    async request(path, method = "GET", data, expected = 200) {
      const response = await fetch(new URL("/api/" + path, base), {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(data ? { "Content-Type": "application/json" } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
        signal: AbortSignal.timeout(45_000),
      });
      assert.match(
        response.headers.get("content-type") ?? "",
        /application\/json/,
        method +
          " /api/" +
          path +
          " returned HTTP " +
          response.status +
          " without JSON",
      );
      const result = await response.json();
      assert.equal(
        response.status,
        expected,
        method + " /api/" + path + " " + JSON.stringify(result),
      );
      cookie = response.headers.getSetCookie()[0]?.split(";")[0] ?? cookie;
      return result;
    },
  };
}

const browser = client();
const api = browser.request;
const workspace = await api("workspace");
assert.deepEqual(
  workspace.configured,
  { gemini: false, maps: false, browserMap: false },
  "Start the offline test server with CITYBUDDY_ALLOW_METERED=0.",
);
assert.equal(workspace.connections.meteredEnabled, false);
assert.equal(workspace.browserMap, null);
assert.equal(workspace.mapPreview.location.name, "Jaipur");
assert.ok(workspace.mapPreview.places.length >= 3);
assert.equal(
  (await api("mcp/health", "GET", undefined, 503)).code,
  "provider_disabled",
);
const last = (session) => session.messages.at(-1);
async function message(session, text) {
  return (
    await api("chat", "POST", {
      user_id: workspace.user_id,
      session_id: session.id,
      mode: session.mode,
      message: text,
      location: session.location,
      request_id: randomUUID(),
    })
  ).session;
}
async function open(mode) {
  return (await api("sessions", "POST", { mode })).session;
}
async function location(query, name) {
  const { choices } = await api("location/resolve", "POST", { query });
  const place = choices.find((row) => row.name === name);
  assert.ok(place, "Expected a cataloged location for " + query);
  return (await api("location", "PATCH", { place_id: place.place_id }))
    .location;
}
async function prepared() {
  for (let attempt = 0; attempt < 35; attempt += 1) {
    const state = await api("outing");
    if (state.prepared) return state.prepared;
    assert.notEqual(state.job?.status, "failed", state.job?.error ?? "");
    await wait(350);
  }
  assert.fail("Worker did not prepare the current context.");
}

await location("Jaipur", "Jaipur");
let talk = await open("live_talk");
talk = await message(talk, "Where can I buy household essentials?");
assert.ok(
  last(talk).metadata.places.some(
    (p) => /household|grocery|market/.test(p.category) && p.sources.length,
  ),
);
assert.deepEqual((await api("items")).items, []);
console.log(
  "PASS A · Jaipur household search uses sourced shop categories and leaves the checklist untouched.",
);

await location("Hawa Mahal, Jaipur", "Hawa Mahal");
let guide = await open("on_site_guide");
guide = await message(guide, "Tell me about this place.");
assert.match(last(guide).content, /1799/);
assert.ok(
  last(guide).metadata.sources.some((source) =>
    source.url.includes("tourism.rajasthan.gov.in"),
  ),
);
guide = await message(guide, "What else can I visit nearby?");
assert.ok(last(guide).metadata.places.length >= 2);
console.log(
  "PASS B · Selected monument history is sourced and nearby attractions are discoverable.",
);

talk = await open("live_talk");
talk = await message(
  talk,
  "I have three hours between meetings, starting at 09:00. Plan an outing with attractions.",
);
const active = (await api("trips/active")).trip;
assert.equal(active.id, last(talk).metadata.tripId);
assert.equal(active.constraints.availableMinutes, 180);
assert.equal(active.constraints.startMinute, 540);
assert.ok(active.feasible);
assert.ok(active.stops.length >= 3);
assert.ok(active.stops.every((s) => s.arrivalMinute + s.visitMinutes <= 720));
assert.match(
  active.notes.join(" "),
  /Estimated return by (?:09|10|11):\d\d|Estimated return by 12:00/,
);
assert.equal(
  await client()
    .request("trips/" + active.id, "GET", null, 404)
    .then((r) => r.code),
  "not_found",
);
console.log(
  "PASS C · Three-hour work-break itinerary persists, fits its window and is private to the owner.",
);

const exploration = await api("recommendations");
assert.ok(new Set(exploration.places.map((p) => p.category)).size > 1);
assert.ok(
  exploration.places.every(
    (p) => p.reason && p.distanceMeters <= exploration.radius,
  ),
);
const shown = exploration.places[0].place_id;
await api("recommendations", "POST", { placeId: shown, action: "dismissed" });
assert.ok(
  (await api("recommendations")).places.every((p) => p.place_id !== shown),
);
console.log(
  "PASS D · Exploration returns ranked, varied recommendations and remembers dismissal.",
);

talk = await message(talk, "I already visited this.");
const visited = (await api("trips/active")).trip;
const completedStop = visited.stops.find((s) => s.status === "visited");
assert.ok(completedStop);
talk = await message(talk, "Skip the next place.");
const replanned = (await api("trips/active")).trip;
assert.equal(replanned.version, visited.version + 1);
assert.deepEqual(
  replanned.stops.find((s) => s.id === completedStop.id),
  completedStop,
);
assert.ok(replanned.stops.some((s) => s.status === "skipped"));
await api(
  "trips/" + active.id + "/replan",
  "POST",
  { action: "refresh", version: active.version },
  409,
);
console.log(
  "PASS E · Text replanning preserves visited stops, records skipped stops and rejects stale edits.",
);

let items = await open("my_items");
items = await message(items, "I need to buy a phone charger and bedsheets.");
const charger = (await api("items")).items.find(
  (i) => i.name === "phone charger",
);
assert.ok(charger);
items = await message(items, "I bought the phone charger.");
const restored = client(browser.identity());
assert.equal((await restored.request("workspace")).user_id, workspace.user_id);
const restoredSession = (
  await restored.request("sessions", "POST", { mode: "my_items" })
).session;
assert.equal(restoredSession.id, items.id);
items = await message(restoredSession, "What is still pending?");
assert.match(last(items).content, /bedsheets/i);
assert.doesNotMatch(last(items).content, /charger/i);
console.log(
  "PASS F · Returning with the same browser identity restores chat and pending checklist state.",
);

const old = await prepared();
assert.ok(old.nextStop);
const remote = (
  await api("location/simulate", "POST", {
    latitude: 0,
    longitude: 0,
    name: "Simulation coordinate",
  })
).location;
assert.equal(remote.latitude, 0);
assert.equal((await api("workspace")).location.name, "Simulation coordinate");
assert.equal((await api("places/nearby")).places.length, 0);
const updated = await prepared();
assert.notEqual(updated.at, old.at);
assert.equal(updated.recommendations.length, 0);
assert.ok((await api("places/nearby")).radii.length > 1);
await api("location/simulate", "POST", {
  tripId: active.id,
  stopId: completedStop.id,
});
assert.ok((await api("places/nearby")).places.length > 0);
console.log(
  "PASS G · Simulated movement, empty results, fresh preparation and arrival all reflect the new location.",
);

await api("location", "PATCH", { latitude: 26.947, longitude: 75.84 });
talk = await open("live_talk");
talk = await message(talk, "Show nearby attractions.");
const jalMahal = last(talk).metadata.places.find(
  (place) => place.name === "Jal Mahal",
);
assert.ok(jalMahal, "Jal Mahal should be in the nearby recommendations.");
talk = await message(talk, "yhaa se jal mahal kitna door h");
assert.match(last(talk).content, /Yahan se Jal Mahal.*lagbhag.*door hai/);
assert.doesNotMatch(last(talk).content, /\p{Script=Devanagari}/u);
assert.equal(last(talk).metadata.places[0].place_id, jalMahal.place_id);
talk = await message(talk, "How far is it from here?");
assert.match(last(talk).content, /Jal Mahal is about.*straight line/);
talk = await message(talk, "यहाँ से जल महल कितनी दूर है?");
assert.match(last(talk).content, /यहाँ से .* की सीधी दूरी लगभग/);
console.log(
  "PASS H · Jal Mahal follow-ups reuse the recommendation and switch between Hinglish, English and Hindi.",
);
