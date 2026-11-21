import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  defaults,
  preferencesSchema,
  type NearbyInput,
  type Preferences,
  type Prepared,
} from "../../outing-contracts";
import { type Location } from "../../contracts";
import { AppError, notFound } from "../errors";
import { db } from "../db";
import { localPlaces } from "./catalog";
import { discover } from "./geo";
import { recordMetric } from "../metrics";

export type Database = Prisma.TransactionClient;
export const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export async function loadPreferences(
  store: Database,
  userId: string,
): Promise<Preferences> {
  const row = await store.userPreference.findUnique({ where: { userId } });
  return row
    ? preferencesSchema.parse({
        mode: row.mode,
        maxDistanceMeters: row.maxDistanceMeters,
        availableMinutes: row.availableMinutes,
        interests: row.interests,
      })
    : defaults;
}

export async function loadContext(store: Database, userId: string) {
  const [user, preferences, items, trip, latestDismissal] = await Promise.all([
    store.user.findUnique({
      where: { id: userId },
      select: { selectedLocation: true },
    }),
    loadPreferences(store, userId),
    store.shoppingItem.findMany({
      where: { userId, status: "pending" },
      orderBy: { id: "asc" },
    }),
    store.trip.findFirst({
      where: { userId, status: "active" },
      include: {
        stops: {
          where: { status: "pending" },
          orderBy: { position: "asc" },
          take: 1,
        },
      },
    }),
    store.recommendationEvent.findFirst({
      where: { userId, action: "dismissed" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    }),
  ]);
  if (!user) throw notFound();
  const location = user.selectedLocation as Location | null;
  const anchor = location && [
    location.latitude.toFixed(3),
    location.longitude.toFixed(3),
    location.place_id.startsWith("coordinate:") ? null : location.place_id,
  ];
  const basis = createHash("sha256")
    .update(
      JSON.stringify({
        anchor,
        preferences,
        items: items.map((i) => [i.id, i.name, i.quantity, i.updatedAt]),
        trip: trip && [trip.id, trip.version],
        lastDismissal: latestDismissal?.id,
      }),
    )
    .digest("hex");
  return { location, preferences, items, trip, basis };
}

export async function seenPlaces(store: Database, userId: string) {
  const events = await store.recommendationEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { placeId: true, action: true },
  });
  return {
    visited: new Set(
      events.filter((e) => e.action === "visited").map((e) => e.placeId),
    ),
    dismissed: new Set(
      events.filter((e) => e.action === "dismissed").map((e) => e.placeId),
    ),
    shown: new Set(
      events.filter((e) => e.action === "shown").map((e) => e.placeId),
    ),
  };
}

export async function nearbyForUser(userId: string, input: NearbyInput) {
  const start = performance.now();
  const [context, seen] = await Promise.all([
    loadContext(db, userId),
    seenPlaces(db, userId),
  ]);
  if (!context.location)
    throw new AppError(
      409,
      "Set a location before searching nearby.",
      "location_required",
    );
  const result = discover(
    context.location,
    context.preferences,
    input,
    localPlaces(),
    seen,
  );
  recordMetric("local_place_search", performance.now() - start);
  return {
    ...result,
    durationMs: Math.round(performance.now() - start),
    provider: "local_catalog" as const,
  };
}

export async function queuePreparation(store: Database, userId: string) {
  const { basis, location } = await loadContext(store, userId);
  await store.backgroundJob.updateMany({
    where: {
      userId,
      kind: "prepare_context",
      status: { in: ["created", "queued", "waiting", "running"] },
      ...(location ? { NOT: { basis } } : {}),
    },
    data: { status: "cancelled", lockedUntil: null },
  });
  await store.preparedContext.deleteMany({
    where: { userId, ...(location ? { NOT: { basis } } : {}) },
  });
  if (!location) return null;
  const now = new Date();
  const ready = await store.preparedContext.findFirst({
    where: { userId, basis, expiresAt: { gt: now } },
  });
  if (ready) return null;
  const key = "prepare:" + basis + ":" + Math.floor(now.getTime() / 600_000);
  await store.backgroundJob.updateMany({
    where: { userId, key, status: { in: ["completed", "cancelled"] } },
    data: {
      status: "created",
      runAt: now,
      attempts: 0,
      error: null,
      lockedUntil: null,
    },
  });
  return store.backgroundJob.upsert({
    where: { userId_key: { userId, key } },
    create: {
      userId,
      key,
      basis,
      kind: "prepare_context",
      status: "created",
      runAt: now,
    },
    update: {},
  });
}

export async function savePreferences(
  userId: string,
  preferences: Preferences,
) {
  return db.$transaction(async (tx) => {
    const data = { ...preferences, interests: json(preferences.interests) };
    await tx.userPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    await queuePreparation(tx, userId);
    return preferences;
  });
}

export async function getPreparation(userId: string) {
  const context = await loadContext(db, userId);
  const [prepared, job] = await Promise.all([
    db.preparedContext.findFirst({
      where: { userId, basis: context.basis, expiresAt: { gt: new Date() } },
    }),
    db.backgroundJob.findFirst({
      where: { userId, kind: "prepare_context", basis: context.basis },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        attempts: true,
        error: true,
        runAt: true,
      },
    }),
  ]);
  recordMetric(prepared ? "prepared_cache_hit" : "prepared_cache_miss");
  return { prepared: (prepared?.payload as Prepared | undefined) ?? null, job };
}
