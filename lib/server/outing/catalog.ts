import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { placeSchema, type Location, type Workspace } from "../../contracts";
import { category, coordinates } from "../../outing-contracts";
import { normalize, type CatalogPlace } from "./geo";
import jaipur from "./jaipur.json";
import { AppError } from "../errors";

const entry = placeSchema.extend({
  ...coordinates.shape,
  category: z.union([category, z.literal("location")]),
  aliases: z.array(z.string()).optional(),
  attributes: z.array(z.string()).optional(),
  translations: z
    .object({
      hi: z.string().optional(),
      hinglish: z.string().optional(),
    })
    .optional(),
});
type Entry = z.infer<typeof entry>;
const base = z.array(entry).parse(jaipur);
const previewCenter = base.find(
  (place) => place.place_id === "osm:node/315734346",
);
const preview: Workspace["mapPreview"] = previewCenter
  ? {
      location: { ...previewCenter, source: "manual" },
      places: base.filter((place) =>
        [
          "Hawa Mahal",
          "Jal Mahal",
          "Albert Hall Museum",
          "City Palace",
        ].includes(place.name),
      ),
    }
  : null;
let imported: { path: string; modified: number; rows: Entry[] } | undefined;

export function jaipurMapPreview() {
  return preview;
}

export interface PlaceCatalog {
  entries(): Entry[];
}

export const localCatalog: PlaceCatalog = {
  entries() {
    const path = process.env.CITYBUDDY_PLACE_CATALOG?.trim();
    if (!path) return base;
    try {
      const stat = statSync(path);
      if (stat.size > 12 * 1024 * 1024)
        throw new Error("Catalog is larger than 12 MiB");
      if (imported?.path === path && imported.modified === stat.mtimeMs)
        return imported.rows;
      const additions = z
        .array(entry)
        .max(25000)
        .parse(JSON.parse(readFileSync(path, "utf8")));
      const rows = [
        ...new Map(
          [...base, ...additions].map((row) => [row.place_id, row]),
        ).values(),
      ];
      imported = { path, modified: stat.mtimeMs, rows };
      return rows;
    } catch {
      throw new AppError(
        503,
        "The configured local place catalog could not be read. Check its file and format.",
        "catalog_unavailable",
      );
    }
  },
};
export function localPlaces(): CatalogPlace[] {
  return localCatalog
    .entries()
    .filter((row): row is CatalogPlace => row.category !== "location");
}
export function coordinateLocation(
  latitude: number,
  longitude: number,
  name?: string,
): Location {
  return {
    place_id: "coordinate:" + latitude.toFixed(6) + "," + longitude.toFixed(6),
    name: name ?? latitude.toFixed(5) + ", " + longitude.toFixed(5),
    formatted_address: null,
    latitude,
    longitude,
    source: "manual",
    sources: [],
  };
}
export function resolveLocal(query: string): Location[] {
  const pairs = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(
    query.trim(),
  );
  if (pairs) {
    const parsed = coordinates.parse({
      latitude: Number(pairs[1]),
      longitude: Number(pairs[2]),
    });
    return [coordinateLocation(parsed.latitude, parsed.longitude)];
  }
  const search = normalize(query.replace(/,\s*jaipur$/i, ""));
  if (!search) return [];
  return localCatalog
    .entries()
    .flatMap((row) => {
      const names = [row.name, ...(row.aliases ?? [])].map(normalize);
      const score = names.includes(search)
        ? 3
        : names.some((name) => name.startsWith(search))
          ? 2
          : normalize(row.formatted_address ?? "").includes(search)
            ? 1
            : 0;
      return score ? [{ row, score }] : [];
    })
    .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
    .slice(0, 8)
    .map(({ row }) => ({ ...row, source: "manual" }));
}
