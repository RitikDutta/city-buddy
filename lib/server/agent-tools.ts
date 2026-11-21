import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FunctionDeclaration } from "@google/genai";
import {
  createItemSchema,
  updateItemSchema,
  type GeoContext,
  type Item,
  type Location,
  type MessageMeta,
  type Place,
} from "../contracts";
import { AppError, missingProvider } from "./errors";
import { mapsUrl } from "./location";
import { navigationLink, record, sources } from "./map-results";
import { supported, type Args, type MapsConnection } from "./maps";
import { placeDetails } from "./places";
import type { ItemChange } from "./repository";

const local = {
  cite_history: {
    description:
      "Before explaining a historical fact, provide the exact supporting excerpt from the named place's retrieved summary and its verified place ID.",
    schema: z
      .object({
        place_id: z.string().min(1),
        excerpt: z.string().trim().min(12).max(700),
      })
      .strict(),
  },
  get_items: {
    description:
      "Read the user's persisted checklist. Use before answering list questions or identifying an item for a change or store search.",
    schema: z.object({}).strict(),
  },
  add_item: {
    description: "Add a new shopping item explicitly requested by the user.",
    schema: createItemSchema,
  },
  update_item: {
    description:
      "Update an existing item by its exact checklist ID. Use purchased or pending for status.",
    schema: z.object({ id: z.uuid(), changes: updateItemSchema }).strict(),
  },
  delete_item: {
    description: "Delete the requested item by its exact checklist ID.",
    schema: z.object({ id: z.uuid() }).strict(),
  },
  focus_place: {
    description:
      "Select an exact previously returned place ID. Use for positional follow-ups, e.g. the second place. Returns the grounding summary and sources.",
    schema: z.object({ place_id: z.string().min(1) }).strict(),
  },
  place_details: {
    description:
      "Fetch optional Google Places (New) structured hours and rating for a previously resolved place.",
    schema: z.object({ place_id: z.string().min(1) }).strict(),
  },
  ask_clarification: {
    description:
      "Ask one short question if the user's item, destination or intended action is ambiguous.",
    schema: z.object({ question: z.string().min(1).max(500) }).strict(),
  },
};
type LocalName = keyof typeof local;
const knownPlaces = (places: Place[]) => [
  ...new Map(places.map((p) => [p.place_id, p])).values(),
];
function placeEvidence(place: Place) {
  return {
    place_id: place.place_id,
    name: place.name,
    formatted_address: place.formatted_address,
    summary: place.summary,
    sources: place.sources.map((source) => source.title),
  };
}

export class TurnTools {
  readonly metadata: MessageMeta = {
    tools: [],
    places: [],
    routes: [],
    sources: [],
  };
  readonly context: GeoContext;
  clarification = "";
  citedPlaceId?: string;
  private initial: Map<string, Item>;
  private working: Map<string, Item>;
  private touched = new Set<string>();
  private resolved = new Map<string, string>();
  private knownSources = new Map<string, Place>();
  constructor(
    readonly location: Location | null,
    context: GeoContext,
    items: Item[],
    readonly maps: MapsConnection | null,
  ) {
    this.context = structuredClone(context);
    this.initial = new Map(items.map((i) => [i.id, i]));
    this.working = new Map(this.initial);
    for (const p of [
      ...context.known,
      ...context.places,
      ...(location ? [location] : []),
    ])
      this.knownSources.set(p.place_id, p);
  }
  declarations(): FunctionDeclaration[] {
    const declarations: FunctionDeclaration[] = Object.entries(local)
      .filter(
        ([name]) =>
          name !== "place_details" || !!process.env.GOOGLE_PLACES_API_KEY,
      )
      .map(([name, def]) => {
        const { $schema: _draft, ...schema } = z.toJSONSchema(def.schema);
        return {
          name,
          description: def.description,
          parametersJsonSchema: schema,
        };
      });
    for (const tool of this.maps?.tools ?? []) {
      if (!supported.some((name) => name === tool.name)) continue;
      const schema = structuredClone(tool.inputSchema);
      delete schema.$schema;
      if (tool.name === "search_places") {
        schema.properties = {
          ...schema.properties,
          anchor_place_id: {
            type: "string",
            description:
              "Only when the user refers to an earlier destination, use its verified place ID as the nearby-search center. Otherwise omit.",
          },
        };
      }
      declarations.push({
        name: tool.name,
        description: tool.description || tool.name,
        parametersJsonSchema: schema,
      });
    }
    return declarations;
  }
  changes(): ItemChange[] {
    return [...this.touched]
      .map((id) => ({
        before: this.initial.get(id),
        after: this.working.get(id),
      }))
      .filter((x) => x.before || x.after);
  }
  modelContext() {
    return {
      location: this.location && {
        ...placeEvidence(this.location),
        latitude: this.location.latitude,
        longitude: this.location.longitude,
      },
      places: this.context.places.map(placeEvidence),
      focus: this.context.focus && placeEvidence(this.context.focus),
      known: this.context.known.map(({ place_id, name }) => ({
        place_id,
        name,
      })),
      routes: this.context.routes.map(
        ({ mode, distance_meters, duration_seconds }) => ({
          mode,
          distance_meters,
          duration_seconds,
        }),
      ),
    };
  }
  async call(name: string, args: Args, signal: AbortSignal): Promise<unknown> {
    if (JSON.stringify(args).length > 24000)
      throw new AppError(422, "The tool arguments are too long.");
    if (Object.hasOwn(local, name)) {
      const schema = local[name as LocalName].schema;
      if (!schema.safeParse(args).success)
        throw new AppError(422, "Check the parameters for " + name + ".");
      const result = await this.localCall(name as LocalName, args, signal);
      this.metadata.tools.push(name);
      return result;
    }
    if (!supported.some((tool) => tool === name))
      throw new AppError(422, "This tool is unavailable.");
    if (!this.maps) throw missingProvider("maps");
    if (!this.location)
      throw new AppError(409, "Set your location before using Maps.");
    const input = { ...args };
    let destination: { name: string; place_id: string } | undefined;
    let origin: { name: string; place_id: string } = this.location;
    if (name === "search_places") {
      const anchor =
        args.anchor_place_id === undefined
          ? this.location
          : this.knownSources.get(String(args.anchor_place_id));
      if (!anchor || anchor.latitude === null || anchor.longitude === null)
        throw new AppError(
          422,
          "Choose a search center from the saved location or a returned place.",
        );
      delete input.anchor_place_id;
      const props =
        this.maps.tools.find((t) => t.name === name)?.inputSchema.properties ??
        {};
      const queryKey = Object.hasOwn(props, "textQuery")
        ? "textQuery"
        : "text_query";
      const query = args.textQuery ?? args.text_query;
      if (typeof query !== "string" || !query.trim())
        throw new AppError(422, "Include a place search query.");
      delete input.textQuery;
      delete input.text_query;
      delete input.locationBias;
      delete input.location_bias;
      const supportsBias =
        Object.hasOwn(props, "location_bias") ||
        Object.hasOwn(props, "locationBias");
      input[queryKey] = supportsBias
        ? query
        : query + " near " + (anchor.formatted_address || anchor.name);
      if (Object.hasOwn(props, "location_bias"))
        input.location_bias = {
          circle: {
            center: { latitude: anchor.latitude, longitude: anchor.longitude },
            radius_meters: 5000,
          },
        };
      if (Object.hasOwn(props, "locationBias"))
        input.locationBias = {
          circle: {
            center: { latitude: anchor.latitude, longitude: anchor.longitude },
            radiusMeters: 5000,
          },
        };
    }
    if (name === "compute_routes") {
      const endpoint = (value: unknown) => {
        const point = record(value);
        const id = String(point.place_id ?? point.placeId ?? "").replace(
          /^places\//,
          "",
        );
        const p =
          this.knownSources.get(id) ??
          [...this.knownSources.values()].find(
            (v) =>
              v.name === point.address ||
              (v.formatted_address && v.formatted_address === point.address),
          );
        if (p) return p;
        const label = this.resolved.get(id);
        if (label) return { place_id: id, name: label };
        throw new AppError(
          422,
          "Resolve the endpoint with search_places or resolve_names first, then use its place_id.",
        );
      };
      if (input.origin) origin = endpoint(input.origin);
      destination = endpoint(input.destination);
      input.origin = { place_id: origin.place_id };
      input.destination = { place_id: destination.place_id };
      const waypoints =
        input.intermediateWaypoints ?? input.intermediate_waypoints;
      delete input.intermediateWaypoints;
      if (Array.isArray(waypoints))
        input.intermediate_waypoints = waypoints.map((w) => ({
          place_id: endpoint(w).place_id,
        }));
      const fields =
        this.maps.tools.find((t) => t.name === name)?.inputSchema.properties ??
        {};
      if (
        Object.hasOwn(fields, "includePolyline") ||
        Object.hasOwn(fields, "include_polyline")
      ) {
        delete input.include_polyline;
        input.includePolyline = true;
      }
    }
    if (
      name === "resolve_maps_urls" &&
      (!Array.isArray(args.urls) ||
        !args.urls.every((x) => typeof x === "string" && mapsUrl(x)))
    )
      throw new AppError(422, "Use a Google Maps place URL.");
    const result = await this.maps.call(name, input, signal);
    this.metadata.tools.push(name);
    this.metadata.sources = sources(this.metadata.sources, result.sources);
    if (result.save_url) this.metadata.save_url = result.save_url;
    for (const r of result.resolved) this.resolved.set(r.id, r.label || r.id);
    if (name === "search_places") {
      this.context.places = result.places;
      this.context.routes = [];
      this.context.summary = result.summary;
      this.context.sources = result.sources;
      this.context.focus = result.places.length === 1 ? result.places[0] : null;
      this.context.known = knownPlaces([
        ...this.context.known,
        ...result.places,
      ]).slice(-40);
      for (const p of result.places) this.knownSources.set(p.place_id, p);
      this.metadata.places = result.places;
    } else if (name === "compute_routes" && destination) {
      for (const route of result.routes)
        route.navigation_url ??= navigationLink(
          origin,
          destination,
          route.mode,
        );
      this.context.routes = result.routes;
      this.context.focus =
        this.knownSources.get(destination.place_id) ?? this.context.focus;
      this.metadata.routes = result.routes;
    }
    return {
      summary: result.summary,
      places: result.places.map(placeEvidence),
      resolved: result.resolved,
      routes: result.routes.map(
        ({ mode, distance_meters, duration_seconds }) => ({
          mode,
          distance_meters,
          duration_seconds,
        }),
      ),
    };
  }
  private async localCall(name: LocalName, args: Args, signal: AbortSignal) {
    if (name === "get_items") return { items: [...this.working.values()] };
    if (name === "cite_history") {
      const place = this.knownSources.get(String(args.place_id));
      const excerpt = String(args.excerpt);
      if (!place?.sources.length || !place.summary?.includes(excerpt)) {
        throw new AppError(
          422,
          "This excerpt does not occur in a cited summary for this place. Explain the evidence gap if a historical answer is unavailable.",
        );
      }
      this.metadata.history_excerpt = excerpt;
      this.citedPlaceId = place.place_id;
      this.metadata.sources = sources(this.metadata.sources, place.sources);
      return { excerpt, place: place.name };
    }
    if (name === "ask_clarification") {
      this.clarification = String(args.question);
      return { question: this.clarification };
    }
    if (name === "focus_place" || name === "place_details") {
      const place = this.knownSources.get(String(args.place_id));
      if (!place)
        throw new AppError(
          422,
          "Choose a place ID returned in this location context.",
        );
      this.context.focus = place;
      this.metadata.places = [place];
      const inLastSearch = this.context.places.some(
        (p) => p.place_id === place.place_id,
      );
      this.metadata.sources = sources(
        this.metadata.sources,
        place.sources,
        ...(inLastSearch ? [this.context.sources] : []),
      );
      if (name === "focus_place")
        return {
          place: placeEvidence(place),
          previous_search_summary: inLastSearch ? this.context.summary : "",
        };
      const details = await placeDetails(place.place_id, true, signal);
      if (!details)
        throw new AppError(422, "Structured place details are unavailable.");
      this.metadata.sources = sources(
        this.metadata.sources,
        details.place.sources,
      );
      return details;
    }
    const now = new Date().toISOString();
    if (name === "add_item") {
      const fields = createItemSchema.parse(args);
      const item: Item = {
        quantity: 1,
        notes: "",
        status: "pending",
        ...fields,
        id: randomUUID(),
        created_at: now,
        updated_at: now,
      };
      this.working.set(item.id, item);
      this.touched.add(item.id);
      return { item };
    }
    const id = String(args.id);
    const existing = this.working.get(id);
    if (!existing)
      throw new AppError(
        422,
        "That item is unavailable. Read the list to find the matching item.",
      );
    this.touched.add(id);
    if (name === "delete_item") {
      this.working.delete(id);
      return { deleted: existing.name };
    }
    const item = {
      ...existing,
      ...updateItemSchema.parse(args.changes),
      updated_at: now,
    };
    this.working.set(id, item);
    return { item };
  }
}
