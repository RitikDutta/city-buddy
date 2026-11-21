import type {
  Category,
  Candidate,
  Nearby,
  NearbyInput,
  Preferences,
  TravelMode,
} from "../../outing-contracts";
import type { Place } from "../../contracts";

export type Point = { latitude: number; longitude: number };
export type CatalogPlace = Place &
  Point & { category: Category; aliases?: string[]; attributes?: string[] };
const speeds: Record<TravelMode, number> = {
  walking: 4,
  cycling: 13,
  driving: 22,
};
export const shopCategories: Category[] = [
  "electronics",
  "footwear",
  "grocery",
  "household",
  "market",
];
const patterns: [Category, RegExp][] = [
  [
    "electronics",
    /chargers?|cables?|phones?|electronic|computers?|laptops?|headphones?|batter(y|ies)|usb|adapter/i,
  ],
  ["footwear", /shoes?|footwear|sneakers?|sandals?|boots?/i],
  [
    "grocery",
    /grocer|supermarket|food supplies|vegetables|fruit|milk|bread|rice|snacks/i,
  ],
  [
    "household",
    /household|homeware|bedsheets?|bedding|furniture|kitchen|linen|utensils|cleaning|essentials/i,
  ],
  ["market", /markets?|bazaars?/i],
];
export const normalize = (text: string) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
export function shoppingCategory(text: string): Category {
  return patterns.find(([, re]) => re.test(text))?.[0] ?? "market";
}
export function queryCategories(text: string): Category[] {
  if (/household essentials|household supplies|home essentials/i.test(text))
    return ["household", "grocery", "market"];
  const shops = patterns
    .filter(([, re]) => re.test(text))
    .map(([type]) => type);
  const matches: Category[] = [...shops];
  if (/museum|gallery/i.test(text)) matches.push("museum");
  if (/park|gardens?/i.test(text)) matches.push("park");
  if (/café|cafe|coffee/i.test(text)) matches.push("cafe");
  if (/lunch|breakfast|dinner|restaurants?|meal/i.test(text))
    matches.push("meal");
  if (
    /attraction|touris|sightsee|monuments?|landmarks?|hidden gems?|things to (?:do|see)|interesting places|explor|places to visit|what (?:else )?can (?:i|we) (?:visit|see|do)|show me around/i.test(
      text,
    )
  )
    matches.push("attraction", "museum", "park");
  return [...new Set(matches)];
}
export function distance(a: Point, b: Point) {
  const rad = Math.PI / 180;
  const hav =
    Math.sin(((b.latitude - a.latitude) * rad) / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(((b.longitude - a.longitude) * rad) / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, hav)));
}
export function travelEstimate(meters: number, mode: TravelMode) {
  return Math.ceil((meters * 1.35) / ((speeds[mode] * 1000) / 60));
}
export function searchRadii(
  preferences: Preferences,
  desired: Category[],
  requested?: number,
) {
  const { mode, availableMinutes, maxDistanceMeters } = preferences;
  const activity = desired.some((c) => shopCategories.includes(c))
    ? 3000
    : desired.length
      ? 1500
      : 800;
  const timeRadius = Math.floor(
    ((Math.max(10, availableMinutes - 15) / 2) * speeds[mode] * 1000) /
      60 /
      1.35,
  );
  const maximum = Math.min(maxDistanceMeters, timeRadius);
  if (requested !== undefined) return [Math.min(requested, maximum)];
  const radii = [
    Math.min(
      maximum,
      mode === "driving" ? 5000 : mode === "cycling" ? 2500 : activity,
    ),
  ];
  while (radii.at(-1)! < maximum)
    radii.push(Math.min(maximum, Math.ceil(radii.at(-1)! * 1.8)));
  return radii;
}
type Seen = {
  visited?: ReadonlySet<string>;
  dismissed?: ReadonlySet<string>;
  shown?: ReadonlySet<string>;
};
const defaultWeights = {
  interest: 0.25,
  travel: 0.2,
  quality: 0.15,
  novelty: 0.15,
  match: 0.15,
  diversity: 0.1,
};
export function discover(
  origin: Point,
  preferences: Preferences,
  input: NearbyInput,
  catalog: CatalogPlace[],
  seen: Seen = {},
  weights = defaultWeights,
): Nearby {
  const desired = input.categories.length
    ? input.categories
    : input.explore && !input.query
      ? [
          ...new Set<Category>([
            "attraction",
            "museum",
            "park",
            "cafe",
            "market",
            ...preferences.interests,
          ]),
        ]
      : queryCategories(input.query);
  const meters = input.query ? normalize(input.query) : "";
  const meaningful = meters
    .split(" ")
    .filter(
      (word) =>
        word.length > 2 &&
        !/^(the|and|near|nearby|show|find|here|places|please|can|around|where|for|open|now|with|buy)$/.test(
          word,
        ),
    );
  const radii = searchRadii(preferences, desired, input.radius);
  const max = radii.at(-1)!;
  const eligible = catalog.flatMap((place) => {
    if (seen.dismissed?.has(place.place_id)) return [];
    const name = normalize(
      [place.name, ...(place.aliases ?? []), ...(place.attributes ?? [])].join(
        " ",
      ),
    );
    const lexical = meaningful.some((word) => name.includes(word));
    if (
      desired.length
        ? !desired.includes(place.category) && !lexical
        : meaningful.length && !lexical
    )
      return [];
    const d = Math.round(distance(origin, place));
    if (d > max) return [];
    const travelMinutes = travelEstimate(d, preferences.mode);
    if (travelMinutes * 2 > preferences.availableMinutes) return [];
    const interest = preferences.interests.includes(place.category) ? 1 : 0.35;
    const novelty = seen.visited?.has(place.place_id)
      ? 0
      : seen.shown?.has(place.place_id)
        ? 0.4
        : 1;
    const preference = lexical
      ? 1
      : desired.includes(place.category)
        ? 0.85
        : 0.5;
    const quality = place.sources.length ? 0.75 : 0.25;
    const score =
      weights.interest * interest +
      weights.travel * (1 - d / Math.max(max, 1)) +
      weights.quality * quality +
      weights.novelty * novelty +
      weights.match * preference;
    const reason = lexical
      ? "Matches your search"
      : preferences.interests.includes(place.category)
        ? "Matches a saved interest"
        : novelty === 1 && input.explore
          ? "New to your recent recommendations"
          : "Within your travel preferences";
    return [{ ...place, distanceMeters: d, travelMinutes, reason, score }];
  });
  const used: number[] = [];
  let within: Candidate[] = [];
  for (const radius of radii) {
    used.push(radius);
    within = eligible.filter((place) => place.distanceMeters <= radius);
    if (within.length >= Math.min(input.limit, 4)) break;
  }
  const ranked: Candidate[] = [];
  const counts = new Map<Category, number>();
  const seed = Math.floor(Date.now() / 86_400_000);
  const variety = (p: Candidate) =>
    input.explore
      ? (([...p.place_id].reduce(
          (v, c) => Math.imul(v ^ c.charCodeAt(0), 16777619),
          seed,
        ) >>>
          0) /
          2 ** 32) *
        0.045
      : 0;
  while (within.length && ranked.length < input.limit) {
    const adjusted = (p: Candidate) =>
      p.score +
      weights.diversity / (1 + (counts.get(p.category) ?? 0)) +
      variety(p);
    within.sort(
      (a, b) =>
        adjusted(b) - adjusted(a) ||
        a.distanceMeters - b.distanceMeters ||
        a.place_id.localeCompare(b.place_id),
    );
    const next = within.shift()!;
    ranked.push({ ...next, score: Math.min(1, adjusted(next)) });
    counts.set(next.category, (counts.get(next.category) ?? 0) + 1);
  }
  return {
    places: ranked,
    radius: used.at(-1)!,
    radii: used,
    candidateCount: within.length + ranked.length,
    distanceBasis: "straight_line",
  };
}
