import { type BackgroundJob } from "@prisma/client";
import {
  nearbyInput,
  type Candidate,
  type Prepared,
} from "../../outing-contracts";
import type { Place } from "../../contracts";
import { db } from "../db";
import { notFound } from "../errors";
import { localPlaces } from "./catalog";
import { json, loadContext, seenPlaces } from "./context";
import { discover, distance, searchRadii, shoppingCategory } from "./geo";
import { replanTrip } from "./trips";
import { recordMetric } from "../metrics";

const active = ["created", "queued", "running", "waiting"];
let busy = false;
export async function cancelJob(userId: string, id: string) {
  const row = await db.backgroundJob.findFirst({ where: { id, userId } });
  if (!row) throw notFound();
  if (active.includes(row.status))
    await db.backgroundJob.updateMany({
      where: { id, userId, status: { in: active } },
      data: { status: "cancelled", lockedUntil: null },
    });
  return getJob(userId, id);
}
export async function getJob(userId: string, id: string) {
  const job = await db.backgroundJob.findFirst({
    where: { id, userId },
    select: {
      id: true,
      status: true,
      kind: true,
      attempts: true,
      runAt: true,
      error: true,
    },
  });
  if (!job) throw notFound();
  return job;
}

async function prepare(job: BackgroundJob) {
  const snapshot = await loadContext(db, job.userId);
  const location = snapshot.location;
  if (!location || snapshot.basis !== job.basis) {
    await db.backgroundJob.updateMany({
      where: { id: job.id, status: "running", lockedUntil: job.lockedUntil },
      data: { status: "cancelled", lockedUntil: null },
    });
    return;
  }
  const next = snapshot.trip?.stops[0];
  const nextPlace = next?.place as Place | null | undefined;
  const points = localPlaces();
  const nextCatalog = points.find((p) => p.place_id === nextPlace?.place_id);
  const anchor =
    nextCatalog &&
    next?.kind !== "shopping" &&
    distance(nextCatalog, location) <=
      searchRadii(snapshot.preferences, []).at(-1)!
      ? nextCatalog
      : location;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env.CITYBUDDY_TIME_ZONE || "Asia/Kolkata",
    hour: "numeric",
    hourCycle: "h23",
  }).format(new Date());
  const lunch = Number(time) >= 11 && Number(time) < 14;
  const categories =
    next?.kind === "shopping"
      ? [...new Set(snapshot.items.map((i) => shoppingCategory(i.name)))]
      : lunch || next?.kind === "meal"
        ? ["meal" as const]
        : ["attraction" as const, "museum" as const, "park" as const];
  const seen = await seenPlaces(db, job.userId);
  const result = discover(
    anchor,
    snapshot.preferences,
    nearbyInput.parse({ categories, limit: 4 }),
    points,
    seen,
  );
  const recommendations = result.places.filter(
    (p) => p.place_id !== nextPlace?.place_id,
  );
  const candidate: Candidate | undefined = recommendations[0];
  const idea = next
    ? next.label
    : candidate &&
      (lunch
        ? "Lunch option nearby: " + candidate.name
        : candidate.distanceMeters <= 1600
          ? "Explore nearby: " + candidate.name
          : undefined);
  await db.$transaction(async (tx) => {
    const current = await loadContext(tx, job.userId);
    const running = {
      id: job.id,
      status: "running",
      lockedUntil: job.lockedUntil,
    };
    if (current.basis !== job.basis || !current.location) {
      await tx.backgroundJob.updateMany({
        where: running,
        data: { status: "cancelled", lockedUntil: null },
      });
      return;
    }
    if (!(await tx.backgroundJob.findFirst({ where: running }))) return;
    // Item mutations can make a grouped shopping stop redundant. Replan against current tasks.
    if (current.trip) {
      const shopping = await tx.tripStop.findMany({
        where: { tripId: current.trip.id, status: "pending", kind: "shopping" },
      });
      const pendingIds = new Set(current.items.map((i) => i.id));
      if (
        shopping.some((stop) =>
          (stop.itemIds as string[]).some((id) => !pendingIds.has(id)),
        )
      ) {
        await replanTrip(tx, job.userId, current.trip.id, {
          version: current.trip.version,
          action: "refresh",
        });
        return;
      }
    }
    const now = new Date();
    const placeId = nextPlace?.place_id ?? candidate?.place_id;
    const cooldown =
      placeId &&
      (await tx.recommendationEvent.findFirst({
        where: {
          userId: job.userId,
          placeId,
          action: "suggested",
          createdAt: { gt: new Date(now.getTime() - 20 * 60000) },
        },
      }));
    const suggestion = idea && !cooldown ? idea : undefined;
    const payload: Prepared = {
      at: now.toISOString(),
      nextStop: next?.label ?? null,
      overview: nextCatalog?.summary,
      recommendations,
      suggestion,
      radius: result.radius,
      candidateCount: result.candidateCount,
      recommendationAnchor: anchor.name,
      pendingShopping: snapshot.items.length,
    };
    if (suggestion && placeId)
      await tx.recommendationEvent.create({
        data: { userId: job.userId, placeId, action: "suggested" },
      });
    const data = {
      basis: job.basis,
      payload: json(payload),
      expiresAt: new Date(now.getTime() + 10 * 60000),
    };
    await tx.preparedContext.upsert({
      where: { userId: job.userId },
      create: { userId: job.userId, ...data },
      update: data,
    });
    await tx.backgroundJob.updateMany({
      where: running,
      data: { status: "completed", lockedUntil: null, error: null },
    });
    recordMetric("preparation_completed");
    if (payload.recommendations.length || payload.nextStop)
      recordMetric("preparation_with_results");
  });
}

export async function workOnce() {
  if (busy) return false;
  busy = true;
  let job: BackgroundJob | null = null;
  try {
    const now = new Date();
    // Expired leases can be picked up again after restart, with the same retry cap.
    await db.backgroundJob.updateMany({
      where: {
        status: "running",
        lockedUntil: { lte: now },
        attempts: { gte: 3 },
      },
      data: {
        status: "failed",
        lockedUntil: null,
        error: "The worker stopped while preparing this outing.",
      },
    });
    await db.backgroundJob.updateMany({
      where: {
        status: "running",
        lockedUntil: { lte: now },
        attempts: { lt: 3 },
      },
      data: { status: "waiting", lockedUntil: null, runAt: now },
    });
    await db.backgroundJob.updateMany({
      where: { status: "created", runAt: { lte: now } },
      data: { status: "queued" },
    });
    const due = await db.backgroundJob.findFirst({
      where: { status: { in: ["queued", "waiting"] }, runAt: { lte: now } },
      orderBy: { runAt: "asc" },
    });
    if (!due) return false;
    const lockedUntil = new Date(now.getTime() + 60_000);
    const claimed = await db.backgroundJob.updateMany({
      where: { id: due.id, status: due.status, attempts: due.attempts },
      data: { status: "running", lockedUntil, attempts: { increment: 1 } },
    });
    if (!claimed.count) return false;
    job = {
      ...due,
      status: "running",
      lockedUntil,
      attempts: due.attempts + 1,
    };
    await prepare(job);
    return true;
  } catch {
    if (job)
      await db.backgroundJob.updateMany({
        where: { id: job.id, status: "running", lockedUntil: job.lockedUntil },
        data: {
          status: job.attempts >= 3 ? "failed" : "waiting",
          lockedUntil: null,
          runAt: new Date(Date.now() + 1200 * 2 ** job.attempts),
          error: "CityBuddy could not prepare this outing.",
        },
      });
    return false;
  } finally {
    busy = false;
  }
}
const shared = globalThis as typeof globalThis & {
  cityBuddyWorker?: ReturnType<typeof setInterval>;
};
export function startWorker() {
  if (shared.cityBuddyWorker || process.env.CITYBUDDY_WORKER === "0") return;
  const tick = () => void workOnce().catch(() => {});
  shared.cityBuddyWorker = setInterval(tick, 1400);
  shared.cityBuddyWorker.unref();
  tick();
}
