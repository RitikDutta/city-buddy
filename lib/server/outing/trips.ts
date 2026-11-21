import { Prisma, type Trip, type TripStop } from "@prisma/client";
import type { Item, Location, Place } from "../../contracts";
import {
  defaults,
  type PlanInput,
  type ReplanInput,
  type Stop,
  type StopDraft,
  type TripConstraints,
} from "../../outing-contracts";
import { db } from "../db";
import { AppError, conflict, notFound } from "../errors";
import { localPlaces } from "./catalog";
import { json, loadContext, queuePreparation, type Database } from "./context";
import { clock, planOuting } from "./planner";
import { inLanguage, type ReplyLanguage } from "../reply-language";

const withStops = { stops: { orderBy: { position: "asc" as const } } };
function view(row: Trip & { stops: TripStop[] }) {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    feasible: row.feasible,
    origin: row.origin as Location,
    constraints: { ...defaults, ...(row.constraints as TripConstraints) },
    notes: row.notes as string[],
    stops: row.stops.map(
      ({
        id,
        position,
        place,
        kind,
        label,
        status,
        mandatory,
        itemIds,
        arrivalMinute,
        visitMinutes,
        travelMinutes,
        travelMeters,
      }): Stop => ({
        id,
        position,
        place: place as Place | null,
        kind: kind as Stop["kind"],
        label,
        status: status as Stop["status"],
        mandatory,
        itemIds: itemIds as string[],
        arrivalMinute,
        visitMinutes,
        travelMinutes,
        travelMeters,
      }),
    ),
  };
}
function stopData(stop: StopDraft, position: number) {
  return {
    ...stop,
    position,
    place: stop.place ? json(stop.place) : Prisma.DbNull,
    itemIds: json(stop.itemIds),
  };
}
async function activeRow(store: Database, userId: string, id?: string) {
  return store.trip.findFirst({
    where: id ? { id, userId } : { userId, status: "active" },
    include: withStops,
    orderBy: { createdAt: "desc" },
  });
}
export async function getTrip(
  userId: string,
  id?: string,
  store: Database = db,
) {
  const row = await activeRow(store, userId, id);
  if (!row && id) throw notFound();
  return row ? view(row) : null;
}

export async function createTrip(
  store: Database,
  userId: string,
  input: PlanInput,
  items?: Item[],
) {
  const existing = await store.trip.findUnique({
    where: { userId_requestId: { userId, requestId: input.requestId } },
    include: withStops,
  });
  if (existing) return view(existing);
  const context = await loadContext(store, userId);
  if (!context.location)
    throw new AppError(
      409,
      "Set a location before planning an outing.",
      "location_required",
    );
  if (
    input.sessionId &&
    !(await store.chatSession.findFirst({
      where: { id: input.sessionId, userId },
    }))
  )
    throw notFound();
  const result = planOuting(
    context.location,
    input.constraints,
    localPlaces(),
    items ??
      context.items.map((i) => ({
        ...i,
        status: "pending",
        created_at: i.createdAt.toISOString(),
        updated_at: i.updatedAt.toISOString(),
      })),
  );
  await store.trip.updateMany({
    where: { userId, status: "active" },
    data: { status: "archived" },
  });
  const trip = await store.trip.create({
    data: {
      userId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      origin: json(context.location),
      constraints: json(input.constraints),
      notes: json(result.notes),
      feasible: result.feasible,
      stops: { create: result.stops.map(stopData) },
    },
    include: withStops,
  });
  await queuePreparation(store, userId);
  return view(trip);
}

export async function replanTrip(
  store: Database,
  userId: string,
  id: string,
  input: ReplanInput,
) {
  const row = await activeRow(store, userId, id);
  if (!row) throw notFound();
  if (row.version !== input.version || row.status !== "active")
    throw conflict(
      "This itinerary changed. Refresh it before applying another update.",
    );
  const previous = view(row);
  const context = await loadContext(store, userId);
  if (!context.location)
    throw new AppError(
      409,
      "Set a location before replanning.",
      "location_required",
    );
  const next = previous.stops.find(
    (s) => s.status === "pending" && (!input.stopId || s.id === input.stopId),
  );
  const visit = input.action === "visit_next" || input.action === "visit_stop";
  const skip = input.action === "skip_next" || input.action === "skip_stop";
  if ((visit || skip) && !next)
    throw new AppError(
      409,
      "There is no matching pending stop.",
      "stop_unavailable",
    );
  if (next && (skip || visit)) {
    await store.tripStop.update({
      where: { id: next.id },
      data: { status: visit ? "visited" : "skipped", completedAt: new Date() },
    });
    next.status = visit ? "visited" : "skipped";
    if (next.place) {
      await store.recommendationEvent.create({
        data: {
          userId,
          placeId: next.place.place_id,
          action: visit ? "visited" : "dismissed",
        },
      });
    }
  }
  const terminal = previous.stops.filter((s) => s.status !== "pending");
  const last = terminal.filter((s) => s.status === "visited").at(-1);
  const start = Math.max(
    previous.constraints.startMinute,
    last ? last.arrivalMinute + last.visitMinutes : 0,
  );
  const remaining =
    input.action === "shorten"
      ? input.remainingMinutes!
      : Math.min(
          previous.constraints.availableMinutes,
          previous.constraints.endMinute - start,
          previous.constraints.startMinute +
            previous.constraints.availableMinutes -
            start,
        );
  const constraints: TripConstraints = {
    ...previous.constraints,
    startMinute: Math.min(start, 1439),
    availableMinutes: Math.max(10, remaining),
    endMinute: Math.min(
      1440,
      Math.max(
        start + 1,
        input.action === "shorten"
          ? start + remaining
          : Math.min(previous.constraints.endMinute, start + remaining),
      ),
    ),
    includeShopping:
      input.action === "remove_shopping"
        ? false
        : previous.constraints.includeShopping,
    meal: input.action === "lunch_first" ? "lunch" : previous.constraints.meal,
  };
  const exclude = new Set(
    terminal.flatMap((s) => (s.place ? [s.place.place_id] : [])),
  );
  const result =
    remaining > 0 && start < 1440
      ? planOuting(
          context.location,
          constraints,
          localPlaces(),
          context.items.map((i) => ({
            ...i,
            status: "pending",
            created_at: i.createdAt.toISOString(),
            updated_at: i.updatedAt.toISOString(),
          })),
          {
            exclude,
            mandatoryDone: exclude,
            mealFirst: input.action === "lunch_first",
            mealDone: terminal.some(
              (s) => s.kind === "meal" && s.status === "visited",
            ),
          },
        )
      : {
          stops: [],
          notes: ["The outing has no remaining scheduled time."],
          feasible: false,
        };
  const changed = await store.trip.updateMany({
    where: { id, userId, version: input.version, status: "active" },
    data: {
      version: { increment: 1 },
      origin: json(context.location),
      constraints: json(constraints),
      notes: json(result.notes),
      feasible: result.feasible,
    },
  });
  if (!changed.count)
    throw conflict(
      "This itinerary changed. Refresh it before applying another update.",
    );
  await store.tripStop.deleteMany({ where: { tripId: id, status: "pending" } });
  const offset = Math.max(-1, ...terminal.map((s) => s.position)) + 1;
  if (result.stops.length)
    await store.tripStop.createMany({
      data: result.stops.map((stop, i) => ({
        tripId: id,
        ...stopData(stop, offset + i),
      })),
    });
  await queuePreparation(store, userId);
  return view(
    await store.trip.findUniqueOrThrow({ where: { id }, include: withStops }),
  );
}
export function tripReply(
  trip: NonNullable<Awaited<ReturnType<typeof getTrip>>>,
  language: ReplyLanguage = "en",
) {
  const say = inLanguage(language);
  const pending = trip.stops.filter((s) => s.status === "pending");
  return [
    pending.length
      ? trip.feasible
        ? say(
            "Here’s your outing plan.",
            "Yeh raha aapka outing plan.",
            "यह रही आपकी भ्रमण योजना।",
          )
        : say(
            "Here’s a partial outing plan.",
            "Yeh raha aapke outing plan ka jo hissa fit hua.",
            "भ्रमण योजना का जो हिस्सा संभव है, वह यहाँ है।",
          )
      : say(
          "There are no pending stops.",
          "Ab koi stop baaki nahi hai.",
          "अब कोई पड़ाव बाकी नहीं है।",
        ),
    ...pending.map(
      (s) =>
        "- " +
        clock(s.arrivalMinute) +
        " **" +
        (s.kind === "break"
          ? say(s.label, "Aaram ka break", "विश्राम")
          : s.label) +
        "** · " +
        s.visitMinutes +
        say(" min", " min", " मिनट"),
    ),
    ...trip.notes.map((note) => tripNote(note, language)),
  ].join("\n");
}

function tripNote(note: string, language: ReplyLanguage) {
  if (language === "en") return note;
  const say = inLanguage(language);
  const time = /^Estimated return by ([0-9:]+)/.exec(note)?.[1];
  if (time)
    return say(
      note,
      `Lagbhag ${time} tak wapas aa sakte ho. Travel time seedhi doori aur aam detour se estimate kiya hai.`,
      `लगभग ${time} तक वापस आ सकते हैं। यात्रा का समय सीधी दूरी और संभावित घुमाव के आधार पर अनुमानित है।`,
    );
  const required = /^Required stop cannot fit: (.+)$/.exec(note)?.[1];
  if (required)
    return say(
      note,
      `${required} ko current plan mein fit nahi kar paaya.`,
      `${required} को मौजूदा योजना में शामिल नहीं कर पाया।`,
    );
  const pending = /^Shopping still pending for (.+)\.$/.exec(note)?.[1];
  if (pending)
    return say(
      note,
      `Yeh shopping abhi baaki hai: ${pending}.`,
      `यह खरीदारी अभी बाकी है: ${pending}।`,
    );
  const amount = /₹(\d+)/.exec(note)?.[1];
  if (amount)
    return say(
      note,
      `₹${amount} ka budget save hai. Prices aur total cost verified nahi hain.`,
      `₹${amount} का बजट सहेजा गया है। कीमतें और कुल खर्च सत्यापित नहीं हैं।`,
    );
  if (note.startsWith("No sourced "))
    return say(
      note,
      "Meal ke liye koi verified jagah time aur travel limits mein fit nahi hui.",
      "भोजन के लिए कोई सत्यापित जगह तय समय और यात्रा सीमा में नहीं मिली।",
    );
  if (note.startsWith("Shop categories"))
    return say(
      note,
      "Yeh possible shops hain. Stock verify nahi hua hai.",
      "ये संभावित दुकानें हैं। स्टॉक सत्यापित नहीं है।",
    );
  if (note.startsWith("A required stop"))
    return say(
      note,
      "Ek zaroori stop local catalog mein nahi mila.",
      "एक ज़रूरी पड़ाव स्थानीय सूची में नहीं मिला।",
    );
  if (note.startsWith("No stops fit"))
    return say(
      note,
      "Current location aur limits ke hisaab se koi stop fit nahi hua.",
      "मौजूदा स्थान और सीमाओं के अनुसार कोई पड़ाव नहीं मिला।",
    );
  if (note.startsWith("The outing has no remaining"))
    return say(
      note,
      "Outing ke liye ab time baaki nahi hai.",
      "भ्रमण के लिए अब समय बाकी नहीं है।",
    );
  return say(
    note,
    "Puri details outing plan mein dekh sakte ho.",
    "पूरा विवरण भ्रमण योजना में देख सकते हैं।",
  );
}
