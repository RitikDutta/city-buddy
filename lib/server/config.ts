export function meteredEnabled() {
  return process.env.CITYBUDDY_ALLOW_METERED === "1";
}

// Publicly named variables are still read from the running server's environment.
function runtimeValue(name: string) {
  return process.env[name]?.trim();
}

const credentials = {
  gemini: () =>
    process.env.gemini_api_city_buddy?.trim() ||
    process.env.GEMINI_API_KEY?.trim(),
  maps: () =>
    process.env.google_map_api_city_buddy?.trim() ||
    process.env.GOOGLE_MAPS_API_KEY?.trim(),
  browserMap: () => runtimeValue("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY"),
};

export function connectionSettings() {
  return {
    meteredEnabled: meteredEnabled(),
    keys: {
      gemini: !!credentials.gemini(),
      maps: !!credentials.maps(),
      browserMap: !!credentials.browserMap(),
    },
  };
}

export function geminiApiKey() {
  if (meteredEnabled()) return credentials.gemini();
}

// Keep the user's server-side Google key separate from the browser map key.
export function mapsApiKey() {
  if (meteredEnabled()) return credentials.maps();
}

export function browserMapConfig() {
  const apiKey = meteredEnabled() ? credentials.browserMap() : undefined;
  return apiKey
    ? { apiKey, mapId: runtimeValue("NEXT_PUBLIC_GOOGLE_MAP_ID") }
    : null;
}
