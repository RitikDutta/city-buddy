import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import {
  defaults,
  nearbyInput,
  planInput,
  tripConstraintsSchema,
} from "../lib/outing-contracts";
import {
  coordinateLocation,
  localPlaces,
  resolveLocal,
} from "../lib/server/outing/catalog";
import {
  discover,
  searchRadii,
  shoppingCategory,
  travelEstimate,
  distance,
} from "../lib/server/outing/geo";
import { planOuting } from "../lib/server/outing/planner";

const directory = mkdtempSync(join(tmpdir(), "citybuddy-outing-"));
const path = join(directory, "fixture.sqlite");
const migrations = "prisma/migrations";
const places = localPlaces();
const hawa = resolveLocal("Hawa Mahal").find((p) => p.name === "Hawa Mahal")!;
const constraints = tripConstraintsSchema.parse({
  ...defaults,
  startMinute: 540,
  endMinute: 720,
});

before(() => {
  process.env.DATABASE_URL = "file:" + path;
  process.env.CITYBUDDY_ALLOW_METERED = "0";
  const sqlite = new DatabaseSync(path);
  for (const entry of readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    sqlite.exec(
      readFileSync(join(migrations, entry.name, "migration.sql"), "utf8"),
    );
    if (entry.name.endsWith("_init")) {
      sqlite.exec(`INSERT INTO "User" (id, identity_hash) VALUES ('legacy-user', 'legacy-identity');
        INSERT INTO "ShoppingItem" (id, user_id, name, quantity, notes, status, updated_at)
        VALUES ('legacy-item', 'legacy-user', 'Existing item', 2, 'Saved note', 'purchased', '2026-11-21');`);
    }
  }
  const existing = sqlite
    .prepare(
      `SELECT name, quantity, notes, status FROM "ShoppingItem" WHERE id = 'legacy-item'`,
    )
    .get();
  assert.deepEqual(
    { ...existing },
    {
      name: "Existing item",
      quantity: 2,
      notes: "Saved note",
      status: "purchased",
    },
  );
  assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  sqlite.close();
});
after(async () => {
  const { db } = await import("../lib/server/db");
  await db.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

test("adaptive search expands only to travel and time caps, and explicit empty results stay empty", () => {
  const radii = searchRadii(defaults, ["attraction"]);
  assert.deepEqual(radii, [1500, 2700, 4074]);
  const short = { ...defaults, availableMinutes: 30 };
  assert.equal(searchRadii(short, ["grocery"], 20000)[0], 370);
  assert.ok(searchRadii({ ...short, mode: "cycling" }, ["grocery"])[0] > 370);
  const nothing = discover(
    coordinateLocation(0, 0),
    defaults,
    nearbyInput.parse({ categories: ["museum"] }),
    places,
  );
  assert.deepEqual(nothing.radii, radii);
  assert.deepEqual(nothing.places, []);
});

test("local recommendations honor category, interests, novelty, dismissal and source provenance", () => {
  const filters = nearbyInput.parse({
    categories: ["attraction", "museum", "park"],
    explore: true,
  });
  const first = discover(hawa, defaults, filters, places);
  const [top, another] = first.places;
  assert.ok(top.sources.length);
  assert.ok(first.places.every((p) => p.score >= 0 && p.score <= 1));
  assert.ok(new Set(first.places.map((p) => p.category)).size > 1);
  const reranked = discover(
    hawa,
    { ...defaults, interests: [another.category] },
    filters,
    places,
    {
      dismissed: new Set([top.place_id]),
      visited: new Set([another.place_id]),
    },
  );
  assert.ok(!reranked.places.some((p) => p.place_id === top.place_id));
  const old = discover(hawa, defaults, { ...filters, explore: false }, [top], {
    visited: new Set([top.place_id]),
  });
  const fresh = discover(hawa, defaults, { ...filters, explore: false }, [top]);
  assert.ok(old.places[0].score < fresh.places[0].score);
  assert.equal(shoppingCategory("phone charger"), "electronics");
  assert.equal(shoppingCategory("shoes"), "footwear");
  assert.equal(shoppingCategory("bedsheets"), "household");
});

test("outing enforces required stops, meal windows and estimated time and distance including return", () => {
  const plan = planOuting(hawa, constraints, places, []);
  assert.ok(plan.feasible);
  const last = plan.stops.at(-1)!;
  assert.ok(last.place?.latitude != null && last.place.longitude != null);
  const back = distance(hawa, {
    latitude: last.place.latitude,
    longitude: last.place.longitude,
  });
  assert.ok(
    last.arrivalMinute +
      last.visitMinutes +
      travelEstimate(back, constraints.mode) <=
      720,
  );
  assert.ok(
    plan.stops.reduce((sum, stop) => sum + stop.travelMeters, back * 1.35) <=
      constraints.maxDistanceMeters,
  );
  const impossible = planOuting(
    hawa,
    {
      ...constraints,
      endMinute: 555,
      meal: "lunch",
      mandatoryIds: [hawa.place_id],
    },
    places,
    [],
  );
  assert.equal(impossible.feasible, false);
  assert.deepEqual(impossible.stops, []);
  assert.match(impossible.notes.join(" "), /lunch stop.*Required stop/);
});

test("shopping completion replans a persisted itinerary and expiry or movement retires old prepared context", async () => {
  const { db } = await import("../lib/server/db");
  const { repository } = await import("../lib/server/repository");
  const { createTrip, getTrip } = await import("../lib/server/outing/trips");
  const { getPreparation, loadPreferences, savePreferences } =
    await import("../lib/server/outing/context");
  const { workOnce } = await import("../lib/server/outing/jobs");
  const { user, token } = await repository.identity();
  const electronics = places.find((p) => p.category === "electronics")!;
  await repository.updateLocation(
    user.id,
    coordinateLocation(electronics.latitude, electronics.longitude),
  );
  await savePreferences(user.id, { ...defaults, interests: ["museum"] });
  assert.deepEqual(
    (await loadPreferences(db, (await repository.identity(token!)).user.id))
      .interests,
    ["museum"],
  );
  const chargeRequest = { name: "Phone charger", requestId: randomUUID() };
  const charger = await repository.addItem(user.id, chargeRequest);
  assert.equal(
    (await repository.addItem(user.id, chargeRequest)).id,
    charger.id,
  );
  const cable = await repository.addItem(user.id, { name: "USB cable" });
  await repository.addItem(user.id, { name: "Laptop", status: "skipped" });
  const input = planInput.parse({ requestId: randomUUID(), constraints });
  const trip = await db.$transaction((tx) => createTrip(tx, user.id, input));
  const shop = trip.stops.find((s) => s.kind === "shopping");
  assert.ok(shop, trip.notes.join(" "));
  assert.deepEqual(new Set(shop.itemIds), new Set([charger.id, cable.id]));
  assert.equal(
    (await db.$transaction((tx) => createTrip(tx, user.id, input))).id,
    trip.id,
  );
  await workOnce();
  assert.ok((await getPreparation(user.id)).prepared);
  await repository.editItem(user.id, charger.id, { status: "purchased" });
  assert.equal((await getPreparation(user.id)).prepared, null);
  await workOnce();
  await workOnce();
  const next = (await getTrip(user.id))!;
  assert.equal(next.version, trip.version + 1);
  assert.ok(next.stops.some((s) => s.itemIds.includes(cable.id)));
  assert.ok(next.stops.every((s) => !s.itemIds.includes(charger.id)));
  assert.ok((await getPreparation(user.id)).prepared);
  await db.preparedContext.update({
    where: { userId: user.id },
    data: { expiresAt: new Date(0) },
  });
  assert.equal((await getPreparation(user.id)).prepared, null);
  await repository.updateLocation(user.id, coordinateLocation(0, 0));
  await workOnce();
  const moved = (await getPreparation(user.id)).prepared;
  assert.equal(moved?.recommendations.length, 0);
});

test("preparation jobs are deduplicated, can be cancelled and recover or exhaust their leases", async () => {
  const { db } = await import("../lib/server/db");
  const { repository } = await import("../lib/server/repository");
  const { getPreparation, queuePreparation } =
    await import("../lib/server/outing/context");
  const { cancelJob, getJob, workOnce } =
    await import("../lib/server/outing/jobs");
  const { user } = await repository.identity();
  await repository.updateLocation(user.id, hawa);
  const id = (await getPreparation(user.id)).job!.id;
  assert.equal(
    (await db.$transaction((tx) => queuePreparation(tx, user.id)))?.id,
    id,
  );
  assert.equal((await cancelJob(user.id, id)).status, "cancelled");
  await workOnce();
  assert.equal((await getJob(user.id, id)).status, "cancelled");
  await db.$transaction((tx) => queuePreparation(tx, user.id));
  await db.backgroundJob.update({
    where: { id },
    data: { status: "running", lockedUntil: new Date(0), attempts: 1 },
  });
  await workOnce();
  assert.deepEqual(
    [(await getJob(user.id, id)).status, (await getJob(user.id, id)).attempts],
    ["completed", 2],
  );
  await db.preparedContext.delete({ where: { userId: user.id } });
  await db.$transaction((tx) => queuePreparation(tx, user.id));
  process.env.CITYBUDDY_PLACE_CATALOG = join(directory, "missing.json");
  try {
    await workOnce();
    const retry = await getJob(user.id, id);
    assert.equal(retry.status, "waiting");
    assert.equal(retry.attempts, 1);
    assert.ok(retry.runAt.getTime() > Date.now());
  } finally {
    delete process.env.CITYBUDDY_PLACE_CATALOG;
  }
  await db.backgroundJob.update({
    where: { id },
    data: { status: "running", lockedUntil: new Date(0), attempts: 3 },
  });
  await workOnce();
  assert.equal((await getJob(user.id, id)).status, "failed");
});

test("one text request resolves Jaipur, adds shopping, selects lunch and saves a replay-safe itinerary", async () => {
  const { repository } = await import("../lib/server/repository");
  const { getTrip } = await import("../lib/server/outing/trips");
  const { runTurn } = await import("../lib/server/agent");
  const { user } = await repository.identity();
  const session = await repository.openSession(user.id, "live_talk");
  const input = {
    user_id: user.id,
    session_id: session.id,
    mode: session.mode,
    location: session.location,
    message:
      "I am in Jaipur, have four hours available starting at 10:00, want to buy a charger, see interesting places nearby, and have lunch.",
    request_id: randomUUID(),
  };
  const result = await runTurn(user.id, input);
  assert.equal(result.location?.name, "Jaipur");
  assert.equal(result.messages.at(-1)?.metadata?.tripVersion, 1);
  const trip = (await getTrip(user.id))!;
  assert.equal(trip.constraints.availableMinutes, 240);
  assert.ok(trip.stops.some((s) => s.kind === "meal"));
  assert.ok(trip.stops.some((s) => s.kind === "sightseeing"));
  assert.equal((await runTurn(user.id, input)).messages.length, 2);
  assert.deepEqual(
    (await repository.listItems(user.id)).map((item) => item.name),
    ["charger"],
  );
});

test("local chat recognizes common guide and discovery wording and sources legacy map locations", async () => {
  const { repository } = await import("../lib/server/repository");
  const { runTurn } = await import("../lib/server/agent");
  const { user } = await repository.identity();
  await repository.updateLocation(user.id, {
    ...hawa,
    place_id: "existing-legacy-place-id",
    name: "Hawa Mahal, Jaipur",
    summary: undefined,
    sources: [],
  });
  let session = await repository.openSession(user.id, "on_site_guide");
  async function ask(message: string) {
    session = await runTurn(user.id, {
      user_id: user.id,
      session_id: session.id,
      mode: session.mode,
      location: session.location,
      message,
      request_id: randomUUID(),
    });
    return session.messages.at(-1)!;
  }
  assert.match((await ask("Hi!")).content, /Hi!.*Hawa Mahal/);
  const guide = await ask("What’s this building?");
  assert.match(guide.content, /1799/);
  assert.ok(
    guide.metadata?.sources.some((source) =>
      source.url.includes("tourism.rajasthan.gov.in"),
    ),
  );
  for (const wording of [
    "What’s around me?",
    "Show me around",
    "What can I do here?",
  ]) {
    const discovery = await ask(wording);
    assert.ok(
      discovery.metadata?.places.length && discovery.metadata.places.length > 1,
    );
  }
  assert.match(
    (await ask("How do I get to Albert Hall Museum?")).content,
    /Albert Hall Museum is .* straight line/,
  );
  assert.match(
    (await ask("any ideas?")).content,
    /asking about the selected place/,
  );
});

test("Jal Mahal distance follow-ups use the recommended coordinates and match each message's language", async (t) => {
  const { repository } = await import("../lib/server/repository");
  const { gemini, runTurn } = await import("../lib/server/agent");
  const { user } = await repository.identity();
  const origin = coordinateLocation(26.92, 75.82);
  await repository.updateLocation(user.id, origin);
  let session = await repository.openSession(user.id, "live_talk");
  const jal = {
    ...coordinateLocation(26.947, 75.82, "Jal Mahal, Jaipur"),
    place_id: "recommended-jal-mahal",
    sources: [
      {
        title: "Fixture verified listing",
        url: "https://example.test/jal-mahal",
      },
    ],
  };
  const recommendations = [hawa, places[1], jal, places[2]];
  const token = randomUUID();
  await repository.acquire(user.id, session.id, token);
  await repository.commitTurn(
    user.id,
    session.id,
    token,
    randomUUID(),
    "Show nearby attractions.",
    {
      content: "Here are four nearby places.",
      metadata: {
        tools: ["search_places"],
        places: recommendations,
        routes: [],
        sources: [],
      },
      context: {
        ...session.context,
        places: recommendations,
        known: recommendations,
      },
      changes: [],
    },
  );
  session = await repository.session(user.id, session.id);
  const original = {
    flag: process.env.CITYBUDDY_ALLOW_METERED,
    key: process.env.gemini_api_city_buddy,
  };
  t.mock.method(gemini, "next", async () =>
    assert.fail("A known straight-line distance should not call Gemini."),
  );
  async function ask(message: string) {
    session = await runTurn(
      user.id,
      {
        user_id: user.id,
        session_id: session.id,
        mode: session.mode,
        location: session.location,
        message,
        request_id: randomUUID(),
      },
      {
        connect: async () =>
          assert.fail("A known straight-line distance should not call Maps."),
      },
    );
    return session.messages.at(-1)!;
  }
  try {
    process.env.CITYBUDDY_ALLOW_METERED = "1";
    process.env.gemini_api_city_buddy = "local-test-key";
    const hinglish = await ask("yhaa se jal mahal kitna door h");
    assert.match(
      hinglish.content,
      /Yahan se Jal Mahal, Jaipur.*lagbhag \*\*3 km\*\* door hai/,
    );
    assert.doesNotMatch(hinglish.content, /\p{Script=Devanagari}/u);
    assert.equal(hinglish.metadata?.places[0].place_id, jal.place_id);
    assert.equal(hinglish.metadata?.sources[0].url, jal.sources[0].url);
    assert.deepEqual(
      session.context.places.map((place) => place.place_id),
      recommendations.map((place) => place.place_id),
    );
    const english = await ask("How far is the third place?");
    assert.match(
      english.content,
      /Jal Mahal, Jaipur is about \*\*3 km\*\* away in a straight line/,
    );
    const hindi = await ask("यहाँ से जल महल कितनी दूर है?");
    assert.match(hindi.content, /यहाँ से .* की सीधी दूरी लगभग \*\*3 किमी\*\*/);
    assert.doesNotMatch(hindi.content, /straight line/);
    assert.equal(hindi.metadata?.places[0].place_id, jal.place_id);
    process.env.CITYBUDDY_ALLOW_METERED = "0";
    const unclear = await ask("How far is a fictional place with no listing?");
    assert.match(unclear.content, /Where do you want to go/);
  } finally {
    if (original.flag === undefined) delete process.env.CITYBUDDY_ALLOW_METERED;
    else process.env.CITYBUDDY_ALLOW_METERED = original.flag;
    if (original.key === undefined) delete process.env.gemini_api_city_buddy;
    else process.env.gemini_api_city_buddy = original.key;
  }
});
