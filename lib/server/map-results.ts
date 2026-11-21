import type { MapResult, Place, RouteResult, Source } from "../contracts";
import { AppError } from "./errors";

type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const string = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const finite = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export function webLink(v: unknown) {
  if (typeof v !== "string") return undefined;
  try {
    return new URL(v).protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
}
export function sources(...values: unknown[]): Source[] {
  const list = new Map<string, Source>();
  for (const value of values.flatMap((v) => (Array.isArray(v) ? v : [v]))) {
    const row = record(value);
    const title = string(row.title);
    const url = webLink(row.url ?? row.uri);
    if (title && url) list.set(title + "\n" + url, { title, url });
  }
  return [...list.values()];
}
export function parsePlace(value: unknown): Place | null {
  const row = record(value);
  const id =
    string(row.id ?? row.placeId ?? row.place_id) ??
    string(row.place)?.replace(/^places\//, "");
  if (!id) return null;
  const links = record(row.googleMapsLinks ?? row.google_maps_links);
  const attributions = sources(row.attribution, row.attributions, row.sources);
  const location = record(row.location ?? row.coordinates);
  const lat = finite(location.latitude ?? location.lat);
  const lng = finite(location.longitude ?? location.lng);
  const name =
    string(record(row.displayName ?? row.display_name).text) ??
    string(row.displayName) ??
    attributions[0]?.title.replace(/\s+[-–]\s+Google Maps$/i, "") ??
    string(row.title);
  if (!name) return null;
  return {
    place_id: id.replace(/^places\//, ""),
    name,
    formatted_address:
      string(row.formattedAddress ?? row.formatted_address) ?? null,
    latitude: lat !== undefined && Math.abs(lat) <= 90 ? lat : null,
    longitude: lng !== undefined && Math.abs(lng) <= 180 ? lng : null,
    maps_url: webLink(links.placeUrl ?? links.place_url ?? row.googleMapsUri),
    directions_url: webLink(links.directionsUrl ?? links.directions_url),
    summary: string(row.summary) ?? string(record(row.editorialSummary).text),
    sources: attributions,
  };
}
export function resultPayload(result: unknown): RecordValue {
  const wrapped = record(result);
  const blocks = array(wrapped.content).map(record);
  if (wrapped.isError) {
    const details = blocks.map((b) => string(b.text) ?? "").join(" ");
    if (
      /permission.denied|(?:does not|do not) have permission|forbidden|not authorized/i.test(
        details,
      )
    ) {
      throw new AppError(
        502,
        "Google denied access to Maps data. Enable Maps Experience agent tools for the server key’s project and allow that API in its key restrictions.",
        "provider_auth",
      );
    }
    throw new AppError(
      502,
      "Google Maps MCP rejected the tool request. Check the query and your Maps project settings.",
      "maps_tool_error",
    );
  }
  const structured = record(wrapped.structuredContent);
  if (Object.keys(structured).length) return structured;
  for (const block of blocks) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    try {
      const parsed = record(JSON.parse(block.text));
      if (Object.keys(parsed).length) return parsed;
    } catch {
      /* Plain text may carry a summary in older responses. */
    }
  }
  return {
    summary: blocks
      .map((b) => string(b.text) ?? "")
      .join("\n")
      .slice(0, 18000),
  };
}
export function normalizeResult(
  tool: string,
  payload: RecordValue,
  args: RecordValue,
): MapResult {
  const summary = string(payload.summary) ?? "";
  const rawPlaces = array(payload.places);
  const lines = summary.split(/\n+/);
  const places = rawPlaces.flatMap((value, index) => {
    const place = parsePlace(value);
    if (!place) return [];
    const cited = lines.filter((line) => {
      const ids = [...line.matchAll(/\[(\d+)\]/g)].map((match) =>
        Number(match[1]),
      );
      return ids.length && ids.every((id) => id === index);
    });
    place.summary ??=
      (rawPlaces.length === 1 ? summary : cited.join("\n")) || undefined;
    return [place];
  });
  const routes: RouteResult[] = array(payload.routes).map((value) => {
    const row = record(value);
    const seconds = string(row.duration)?.match(/^(\d+(?:\.\d+)?)s$/)?.[1];
    return {
      distance_meters: finite(row.distanceMeters ?? row.distance_meters),
      duration_seconds: seconds === undefined ? undefined : Number(seconds),
      mode: string(args.travel_mode ?? args.travelMode) ?? "",
      encoded_polyline: string(
        row.encodedPolyline ??
          row.encoded_polyline ??
          record(row.polyline).encodedPolyline,
      ),
      navigation_url: webLink(
        row.directionsUrl ?? record(row.googleMapsLinks).directionsUrl,
      ),
      sources: sources(row.attribution, row.attributions),
    };
  });
  const entities =
    tool === "resolve_maps_urls"
      ? array(payload.entities)
      : array(payload.results).map((v) => record(v).entity);
  const resolved = entities.flatMap((entity, i) => {
    const path = string(record(entity).place);
    if (!path?.startsWith("places/")) return [];
    return [
      { id: path.slice(7), label: string(record(array(args.queries)[i]).text) },
    ];
  });
  return {
    summary,
    places,
    routes,
    resolved,
    save_url: webLink(payload.saveToMapsUrl ?? payload.save_to_maps_url),
    sources: sources(
      payload.attribution,
      ...places.map((p) => p.sources),
      ...routes.map((r) => r.sources),
    ),
  };
}

export function navigationLink(
  origin: Pick<Place, "place_id" | "name">,
  dest: Pick<Place, "place_id" | "name">,
  mode: string,
) {
  const url = new URL("https://www.google.com/maps/dir/");
  const travel = (
    {
      WALK: "walking",
      DRIVE: "driving",
      BICYCLE: "bicycling",
      TRANSIT: "transit",
    } as Record<string, string>
  )[mode];
  url.search = new URLSearchParams({
    api: "1",
    origin: origin.name,
    origin_place_id: origin.place_id,
    destination: dest.name,
    destination_place_id: dest.place_id,
    ...(travel ? { travelmode: travel } : {}),
  }).toString();
  return url.toString();
}
