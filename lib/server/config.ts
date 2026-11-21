// Keep the user's server-side Google key separate from the browser map key.
export function mapsApiKey() {
  return (
    process.env.google_map_api_city_buddy?.trim() ||
    process.env.GOOGLE_MAPS_API_KEY?.trim()
  );
}
