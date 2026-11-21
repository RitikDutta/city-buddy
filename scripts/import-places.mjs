// Import an Overpass JSON export prepared by the operator. This command makes no requests.
import { readFileSync, writeFileSync } from "node:fs";

const [output, ...inputs] = process.argv.slice(2);
if (!output || !inputs.length) {
  console.error(
    "Usage: node scripts/import-places.mjs <catalog.json> <overpass-export.json> [...]",
  );
  process.exit(2);
}
const shops = {
  electronics: "electronics",
  mobile_phone: "electronics",
  computer: "electronics",
  shoes: "footwear",
  supermarket: "grocery",
  convenience: "grocery",
  houseware: "household",
  furniture: "household",
  hardware: "household",
  fabric: "household",
};
const locations = new Set([
  "city",
  "town",
  "suburb",
  "neighbourhood",
  "quarter",
  "village",
]);
const catalog = new Map();
for (const input of inputs) {
  const data = JSON.parse(readFileSync(input, "utf8"));
  if (!Array.isArray(data.elements))
    throw new Error("Expected an Overpass elements array in " + input);
  for (const item of data.elements) {
    const t = item.tags ?? {};
    const name = t["name:en"] || t.name;
    const p = item.center ?? item;
    if (
      !name ||
      !Number.isInteger(item.id) ||
      !["node", "way", "relation"].includes(item.type) ||
      !Number.isFinite(p.lat) ||
      Math.abs(p.lat) > 90 ||
      !Number.isFinite(p.lon) ||
      Math.abs(p.lon) > 180
    )
      continue;
    const category = Object.hasOwn(shops, t.shop)
      ? shops[t.shop]
      : t.tourism === "museum" || t.tourism === "gallery"
        ? "museum"
        : t.leisure === "park"
          ? "park"
          : t.amenity === "restaurant"
            ? "meal"
            : t.amenity === "cafe"
              ? "cafe"
              : t.amenity === "marketplace"
                ? "market"
                : locations.has(t.place)
                  ? "location"
                  : t.tourism || t.historic
                    ? "attraction"
                    : null;
    if (!category) continue;
    const id = item.type + "/" + item.id;
    const url = "https://www.openstreetmap.org/" + id;
    catalog.set(id, {
      place_id: "osm:" + id,
      name,
      category,
      latitude: p.lat,
      longitude: p.lon,
      aliases: [
        ...new Set(
          [t.name, t["name:hi"], t.alt_name].filter((v) => v && v !== name),
        ),
      ],
      attributes: [
        t.cuisine?.replaceAll(";", " "),
        t.diet === "vegetarian" || t["diet:vegetarian"] === "only"
          ? "vegetarian"
          : undefined,
        t.fee ? "fee=" + t.fee : undefined,
      ].filter(Boolean),
      formatted_address:
        [
          t["addr:housenumber"],
          t["addr:street"],
          t["addr:suburb"],
          t["addr:city"],
        ]
          .filter(Boolean)
          .join(", ") || null,
      maps_url: url,
      sources: [{ title: "OpenStreetMap contributors", url }],
    });
  }
}
if (!catalog.size)
  throw new Error("No supported places were found in the supplied exports");
writeFileSync(
  output,
  "[\n" +
    [...catalog.values()].map((p) => "  " + JSON.stringify(p)).join(",\n") +
    "\n]\n",
);
console.log("Imported " + catalog.size + " attributed places.");
