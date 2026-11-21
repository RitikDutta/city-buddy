import type { Place } from "../contracts";
import { AppError, providerError } from "./errors";
import { parsePlace, record, webLink } from "./map-results";
import { meteredEnabled } from "./config";
import { recordMetric } from "./metrics";

// Optional Places API (New) enrichment. Discovery always happens through MCP.
export async function placeDetails(
  placeId: string,
  extended = false,
  signal?: AbortSignal,
) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!meteredEnabled() || !key) return null;
  const fields = [
    "id",
    "displayName",
    "formattedAddress",
    "location",
    "googleMapsUri",
  ];
  if (extended) fields.push("rating", "regularOpeningHours");
  try {
    const timeout = AbortSignal.timeout(6000);
    recordMetric("external_places_request");
    const res = await fetch(
      "https://places.googleapis.com/v1/places/" + encodeURIComponent(placeId),
      {
        headers: {
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": fields.join(","),
        },
        cache: "no-store",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );
    if (!res.ok)
      throw Object.assign(new Error("Places request failed"), {
        status: res.status,
      });
    const raw = record(await res.json());
    const url = webLink(raw.googleMapsUri);
    const title = record(raw.displayName).text;
    const place = parsePlace({
      ...raw,
      attribution: url && title ? { title, url } : undefined,
    });
    if (!place || place.place_id !== placeId)
      throw new AppError(
        502,
        "Google Places returned incomplete place details.",
      );
    return {
      place,
      rating: typeof raw.rating === "number" ? raw.rating : undefined,
      opening_hours: record(raw.regularOpeningHours).weekdayDescriptions,
    };
  } catch (err) {
    throw providerError("Google Places", err);
  }
}
export function mergePlace(primary: Place, details: Place): Place {
  return {
    ...primary,
    name: details.name,
    formatted_address: details.formatted_address ?? primary.formatted_address,
    latitude: primary.latitude ?? details.latitude,
    longitude: primary.longitude ?? details.longitude,
    maps_url: primary.maps_url ?? details.maps_url,
    sources: primary.sources.length ? primary.sources : details.sources,
  };
}
