import type { Item, Location, Place } from "../../contracts";
import type { StopDraft, TripConstraints } from "../../outing-contracts";
import {
  distance,
  normalize,
  shopCategories,
  shoppingCategory,
  travelEstimate,
  type CatalogPlace,
  type Point,
} from "./geo";
import { recordMetric } from "../metrics";

type Choice = Omit<
  StopDraft,
  "arrivalMinute" | "travelMinutes" | "travelMeters"
> & {
  window?: [number, number];
};
const dwell = { sightseeing: 35, shopping: 25, meal: 40, break: 15 };
const mealWindows = {
  breakfast: [420, 660],
  lunch: [690, 900],
  dinner: [1080, 1320],
} as const;
export const clock = (minute: number) =>
  String(Math.floor(minute / 60)).padStart(2, "0") +
  ":" +
  String(minute % 60).padStart(2, "0");

function point(place: Place | null): Point | null {
  return place && place.latitude !== null && place.longitude !== null
    ? { latitude: place.latitude, longitude: place.longitude }
    : null;
}

function schedule(
  origin: Point,
  constraints: TripConstraints,
  order: Choice[],
) {
  let here = origin;
  let minute = constraints.startMinute;
  let meters = 0;
  const stops: StopDraft[] = [];
  for (const choice of order) {
    const { window, ...stop } = choice;
    const to = point(stop.place) ?? here;
    const direct = distance(here, to);
    const travelMinutes = travelEstimate(direct, constraints.mode);
    minute = Math.max(minute + travelMinutes, window?.[0] ?? 0);
    if (window && minute + stop.visitMinutes > window[1]) return null;
    const travelMeters = Math.round(direct * 1.35);
    stops.push({ ...stop, arrivalMinute: minute, travelMinutes, travelMeters });
    minute += stop.visitMinutes;
    meters += travelMeters;
    here = to;
  }
  const back = distance(here, origin);
  const returnMinute = minute + travelEstimate(back, constraints.mode);
  const end = Math.min(
    constraints.endMinute,
    constraints.startMinute + constraints.availableMinutes,
  );
  if (
    returnMinute > end ||
    meters + back * 1.35 > constraints.maxDistanceMeters
  )
    return null;
  return { stops, returnMinute, meters };
}

export function planOuting(
  origin: Location,
  constraints: TripConstraints,
  catalog: CatalogPlace[],
  items: Item[],
  options: {
    exclude?: Set<string>;
    mealFirst?: boolean;
    mealDone?: boolean;
    mandatoryDone?: Set<string>;
  } = {},
) {
  const started = performance.now();
  const notes: string[] = [];
  const availability = catalog.filter(
    (p) =>
      !options.exclude?.has(p.place_id) &&
      (constraints.budgetINR !== 0 || !p.attributes?.includes("fee=yes")),
  );
  const byId = new Map(availability.map((p) => [p.place_id, p]));
  const ranked = availability
    .map((p) => ({ p, distance: distance(origin, p) }))
    .filter((p) => p.distance <= constraints.maxDistanceMeters)
    .sort(
      (a, b) => a.distance - b.distance || a.p.name.localeCompare(b.p.name),
    );
  const order: Choice[] = [];
  const used = new Set<string>();
  const groups = new Set<string>();
  let feasible = true;

  const choiceFor = (
    p: CatalogPlace,
    mandatory = false,
    itemIds: string[] = [],
  ): Choice => {
    const kind = shopCategories.includes(p.category)
      ? "shopping"
      : p.category === "meal" || p.category === "cafe"
        ? "meal"
        : "sightseeing";
    const window =
      kind === "meal" && constraints.meal !== "none"
        ? ([...mealWindows[constraints.meal]] as [number, number])
        : undefined;
    return {
      place: p,
      label: p.name,
      kind,
      mandatory,
      itemIds,
      visitMinutes: dwell[kind],
      window,
    };
  };

  function insert(choices: Choice[], first = false) {
    let best: { order: Choice[]; choice: Choice; cost: number } | undefined;
    for (const choice of choices) {
      if (choice.place && used.has(choice.place.place_id)) continue;
      const min =
        options.mealFirst && order[0]?.kind === "meal" && !first ? 1 : 0;
      for (let i = min; i <= (first ? 0 : order.length); i++) {
        const proposed = [...order.slice(0, i), choice, ...order.slice(i)];
        const result = schedule(origin, constraints, proposed);
        if (!result) continue;
        const cost = result.returnMinute + result.meters / 300;
        if (!best || cost < best.cost) best = { order: proposed, choice, cost };
      }
    }
    if (!best) return false;
    order.splice(0, order.length, ...best.order);
    if (best.choice.place) used.add(best.choice.place.place_id);
    return true;
  }

  if (constraints.meal !== "none" && !options.mealDone) {
    const preference = normalize(constraints.mealPreference);
    const meals = ranked.filter(
      ({ p }) =>
        (p.category === "meal" || p.category === "cafe") &&
        (!preference ||
          normalize([p.name, ...(p.attributes ?? [])].join(" ")).includes(
            preference,
          )),
    );
    if (
      !insert(
        meals.slice(0, 12).map(({ p }) => choiceFor(p, true)),
        options.mealFirst,
      )
    ) {
      notes.push(
        "No sourced " +
          constraints.meal +
          " stop fits the meal window, preferences and travel limits.",
      );
      feasible = false;
    }
  }
  for (const id of new Set(constraints.mandatoryIds)) {
    if (options.mandatoryDone?.has(id) || used.has(id)) continue;
    const p = byId.get(id);
    if (!p || !insert([choiceFor(p, true)])) {
      notes.push(
        p
          ? "Required stop cannot fit: " + p.name
          : "A required stop is unavailable in the local catalog.",
      );
      feasible = false;
    }
  }

  if (constraints.includeShopping) {
    const pending = items.filter((i) => i.status === "pending");
    for (const category of new Set(
      pending.map((i) => shoppingCategory(i.name)),
    )) {
      const matches = pending.filter(
        (i) => shoppingCategory(i.name) === category,
      );
      if (
        insert(
          ranked
            .filter(({ p }) => p.category === category)
            .slice(0, 10)
            .map(({ p }) =>
              choiceFor(
                p,
                false,
                matches.map((x) => x.id),
              ),
            ),
        )
      ) {
        groups.add(category);
      } else {
        notes.push(
          "Shopping still pending for " +
            matches.map((i) => i.name).join(", ") +
            ".",
        );
      }
    }
    if (groups.size)
      notes.push(
        "Shop categories indicate possible sellers. Stock has not been verified.",
      );
  }
  for (const id of new Set(constraints.optionalIds)) {
    const p = byId.get(id);
    if (
      p &&
      (constraints.includeShopping || !shopCategories.includes(p.category))
    )
      insert([choiceFor(p)]);
  }
  const sightseeing = ranked
    .filter(({ p }) => ["attraction", "museum", "park"].includes(p.category))
    .sort(
      (a, b) =>
        Number(constraints.interests.includes(b.p.category)) -
          Number(constraints.interests.includes(a.p.category)) ||
        a.distance - b.distance,
    );
  for (const { p } of sightseeing.slice(0, 20)) {
    if (order.length >= 8) break;
    insert([choiceFor(p)]);
  }
  if (constraints.availableMinutes >= 210 && order.length >= 3) {
    const at = Math.ceil(order.length / 2);
    const pause: Choice = {
      place: null,
      kind: "break",
      label: "Rest break",
      mandatory: false,
      itemIds: [],
      visitMinutes: dwell.break,
    };
    const proposed = [...order.slice(0, at), pause, ...order.slice(at)];
    if (schedule(origin, constraints, proposed)) order.splice(at, 0, pause);
  }
  const routeStart = performance.now();
  const result = schedule(origin, constraints, order);
  recordMetric("local_route_estimate", performance.now() - routeStart);
  if (!result?.stops.length)
    notes.push(
      "No stops fit the current location and constraints in the available catalog.",
    );
  if (result?.stops.length)
    notes.push(
      "Estimated return by " +
        clock(result.returnMinute) +
        ". Travel times use straight-line distances with a detour allowance.",
    );
  if (constraints.budgetINR !== undefined)
    notes.push(
      "Prices are unavailable. The ₹" +
        constraints.budgetINR +
        " budget is saved, and total cost is unverified.",
    );
  recordMetric("trip_planning", performance.now() - started);
  return {
    stops: result?.stops ?? [],
    notes,
    feasible: feasible && !!result?.stops.length,
  };
}
