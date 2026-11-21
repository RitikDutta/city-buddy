import { geminiApiKey, mapsApiKey } from "@/lib/server/config";
import type { NextRequest } from "next/server";
import { withUser } from "@/lib/server/http";
import { repository } from "@/lib/server/repository";

export function GET(req: NextRequest) {
  return withUser(req, async (user) => {
    const browserMapKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    const [items, sessions] = await Promise.all([
      repository.listItems(user.id),
      repository.sessions(user.id),
    ]);
    return {
      user_id: user.id,
      location: user.selectedLocation,
      items,
      sessions,
      browserMap: browserMapKey
        ? {
            apiKey: browserMapKey,
            mapId: process.env.NEXT_PUBLIC_GOOGLE_MAP_ID,
          }
        : null,
      configured: {
        gemini: !!geminiApiKey(),
        maps: !!mapsApiKey(),
        browserMap: !!browserMapKey,
      },
    };
  });
}
