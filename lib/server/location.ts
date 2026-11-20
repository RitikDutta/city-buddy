import { locationSchema, type Location, type Place } from "../contracts";
import { AppError } from "./errors";
import { openMaps, type MapsConnection } from "./maps";
import { mergePlace, placeDetails } from "./places";

export function mapsUrl(text: string) {
  try {
    const u = new URL(text);
    return (
      u.protocol === "https:" &&
      (u.hostname === "maps.app.goo.gl" ||
        (u.hostname === "goo.gl" && u.pathname.startsWith("/maps")) ||
        (/^(?:www\.|maps\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(
          u.hostname,
        ) &&
          (u.hostname.startsWith("maps.") || u.pathname.startsWith("/maps"))))
    );
  } catch {
    return false;
  }
}
export interface LocationProvider {
  resolve(query: string, signal?: AbortSignal): Promise<Location[]>;
}
export class ManualLocationProvider implements LocationProvider {
  constructor(private connect: typeof openMaps = openMaps) {}
  async resolve(query: string, signal?: AbortSignal) {
    const isUrl = mapsUrl(query);
    if (/^https?:/i.test(query) && !isUrl)
      throw new AppError(
        400,
        "Enter a location name or a Google Maps place link.",
      );
    const connection = await this.connect(signal);
    try {
      return await this.choices(connection, query, isUrl, signal);
    } finally {
      await connection.close();
    }
  }
  private async choices(
    connection: MapsConnection,
    query: string,
    isUrl: boolean,
    signal?: AbortSignal,
  ) {
    const names = connection.tools.map((t) => t.name);
    const resolver = isUrl ? "resolve_maps_urls" : "resolve_names";
    if (
      !names.includes("search_places") ||
      (isUrl && !names.includes(resolver))
    )
      throw new AppError(
        503,
        "Google Maps MCP is missing a required location tool.",
      );
    const resolved = names.includes(resolver)
      ? (
          await connection.call(
            resolver,
            isUrl ? { urls: [query] } : { queries: [{ text: query }] },
            signal,
          )
        ).resolved
      : [];
    if (isUrl && !resolved.length) return [];
    const search = await connection.call(
      "search_places",
      {
        text_query: isUrl
          ? "The specific place at " +
            query +
            " (Google place ID " +
            resolved[0].id +
            ")"
          : query,
      },
      signal,
    );
    let places = search.places;
    if (isUrl) places = places.filter((p) => p.place_id === resolved[0].id);
    const unique = new Map(places.map((p) => [p.place_id, p]));
    if (process.env.GOOGLE_PLACES_API_KEY) {
      const ids = [
        ...new Set([...resolved.map((r) => r.id), ...unique.keys()]),
      ].slice(0, 5);
      const details = await Promise.all(
        ids.map((id) => placeDetails(id, false, signal).catch(() => null)),
      );
      for (const result of details) {
        if (!result) continue;
        const primary = unique.get(result.place.place_id);
        unique.set(
          result.place.place_id,
          primary ? mergePlace(primary, result.place) : result.place,
        );
      }
    }
    const candidates: Location[] = [];
    for (const place of unique.values()) {
      const parsed = locationSchema.safeParse({ ...place, source: "manual" });
      if (parsed.success) candidates.push(parsed.data);
    }
    const rank = (p: Place) =>
      resolved.some((r) => r.id === p.place_id) ? 0 : 1;
    return candidates.sort((a, b) => rank(a) - rank(b));
  }
}
