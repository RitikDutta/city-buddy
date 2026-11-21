// Exercise the running app through its public API with a fresh browser-like identity.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

if (existsSync(".env")) process.loadEnvFile(".env");
if (process.env.CITYBUDDY_ALLOW_METERED !== "1") {
  console.log(
    "SKIP  Provider smoke tests require CITYBUDDY_ALLOW_METERED=1. Use npm run test:offline for local workflows.",
  );
  process.exit(0);
}
const base = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
let cookie;
async function request(path, method = "GET", data) {
  const response = await fetch(new URL("/api/" + path, base), {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(185000),
  });
  cookie = response.headers.getSetCookie()[0]?.split(";")[0] ?? cookie;
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      method +
        " " +
        path +
        " returned HTTP " +
        response.status +
        " without JSON.",
    );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      method + " " + path + " (" + response.status + ") " + result.error,
    );
  return result;
}
function pass(text) {
  console.log("PASS  " + text);
}
const workspace = await request("workspace");
const item = (
  await request("items", "POST", { name: "Laptop charger", quantity: 1 })
).item;
assert.ok((await request("items")).items.some((i) => i.id === item.id));
pass("3 · Item persists in a fresh request with the same identity.");
let items = (await request("sessions", "POST", { mode: "my_items" })).session;
let lastTurn = 0;
async function message(session, text) {
  // A single turn can use several model requests. Pace the live smoke test
  // so multistep scenarios also work on projects with a small per-minute quota.
  if (text !== "Stop") {
    await wait(Math.max(0, lastTurn + 30_000 - Date.now()));
    lastTurn = Date.now();
  }
  return (
    await request("sessions/" + session.id + "/messages", "POST", {
      user_id: workspace.user_id,
      session_id: session.id,
      mode: session.mode,
      location: session.location,
      message: text,
      request_id: randomUUID(),
    })
  ).session;
}
function last(s) {
  return s.messages.at(-1);
}
async function setLocation(query, expected) {
  const { choices } = await request("location/resolve", "POST", { query });
  const choice = choices.find((c) =>
    expected.test(c.name + " " + (c.formatted_address || "")),
  );
  assert.ok(choice, "No verified match for " + query);
  await request("location/select", "POST", { place_id: choice.place_id });
  const current = (await request("workspace")).location;
  assert.equal(current.place_id, choice.place_id);
  assert.ok(
    Number.isFinite(current.latitude) && Number.isFinite(current.longitude),
  );
  return current;
}
const failed = [];
async function check(service, work) {
  try {
    await work();
    return true;
  } catch (error) {
    failed.push(service);
    console.error("FAIL  " + service + " · " + error.message);
    return false;
  }
}
let mapsAvailable = false;
let geminiAvailable = false;
if (workspace.configured.maps)
  mapsAvailable = await check("live manual location", async () => {
    assert.equal((await request("mcp/health")).ok, true);
    await setLocation("Mansarovar, Jaipur", /Mansarovar/i);
    items = (await request("sessions/" + items.id)).session;
    pass(
      "1 · Maps MCP resolved Mansarovar and the selected location persisted.",
    );
  });
if (workspace.configured.gemini)
  geminiAvailable = await check("live Gemini memory", async () => {
    items = await message(items, "What items are pending?");
    assert.ok(last(items).metadata.tools.includes("get_items"));
    assert.match(last(items).content, /charger/i);
    pass("4 · Gemini read the saved checklist.");
  });
if (mapsAvailable && geminiAvailable) {
  await check("nearby shops", async () => {
    items = await message(items, "Where can I buy a laptop charger nearby?");
    assert.ok(
      last(items).metadata.tools.includes("search_places") &&
        last(items).metadata.places.length > 0,
    );
    pass("2 · Gemini invoked the real MCP store search.");
  });
  let talk;
  const hasPlaces = await check("tourist search", async () => {
    talk = (await request("sessions", "POST", { mode: "live_talk" })).session;
    talk = await message(talk, "Show nearby tourist places.");
    assert.ok(last(talk).metadata.tools.includes("search_places"));
    assert.ok(
      talk.context.places.length >= 2,
      "Need two verified tourist results.",
    );
  });
  if (hasPlaces) {
    const focused = await check("conversation context", async () => {
      const second = talk.context.places[1];
      talk = await message(talk, "Tell me about the second one.");
      assert.equal(talk.context.focus?.place_id, second.place_id);
      pass("5 · The follow-up refers to the second verified place.");
    });
    if (focused)
      await check("walking route", async () => {
        talk = await message(talk, "How long will it take to walk there?");
        assert.ok(last(talk).metadata.tools.includes("compute_routes"));
        assert.ok(
          last(talk).metadata.routes.some(
            (r) => r.duration_seconds !== undefined && r.mode === "WALK",
          ),
        );
        pass("7 · Walking time came from a Maps MCP route.");
      });
  }
  await check("on-site guide", async () => {
    const reported = await setLocation("Hawa Mahal, Jaipur", /Hawa Mahal/i);
    let guide = (await request("sessions", "POST", { mode: "on_site_guide" }))
      .session;
    guide = await message(guide, "Tell me about this place.");
    assert.ok(last(guide).metadata.tools.includes("search_places"));
    assert.equal(guide.location.place_id, reported.place_id);
    guide = await message(guide, "What else is nearby?");
    assert.ok(last(guide).metadata.tools.includes("search_places"));
    pass("6 · Guide and nearby search used the changed location.");
  });
}
await check("session ending", async () => {
  items = (await request("sessions/" + items.id)).session;
  items = await message(items, "Stop");
  assert.equal(items.status, "ended");
  assert.ok((await request("items")).items.some((i) => i.id === item.id));
  pass("8 · Stop ended the conversation and retained the checklist.");
});
if (!workspace.configured.maps || !workspace.configured.gemini) {
  console.log(
    "LIVE CHECKS INCOMPLETE · Configure " +
      [
        !workspace.configured.maps && "google_map_api_city_buddy",
        !workspace.configured.gemini && "gemini_api_city_buddy",
      ]
        .filter(Boolean)
        .join(" and ") +
      " in .env, restart, and run npm run test:live.",
  );
  process.exitCode = 2;
}

if (failed.length) {
  console.error("Incomplete live workflows: " + failed.join(", "));
  process.exitCode = 1;
}
