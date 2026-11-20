// Keep the user's server-side Google key separate from the browser map key.
export function mapsApiKey() {
  return process.env.GOOGLE_MAPS_API_KEY;
}
