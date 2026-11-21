import { browserMapConfig, connectionSettings } from "@/lib/server/config";
import type { NextRequest } from "next/server";
import { withUser } from "@/lib/server/http";
import { repository } from "@/lib/server/repository";
import { jaipurMapPreview } from "@/lib/server/outing/catalog";

export function GET(req: NextRequest) {
  return withUser(req, async (user) => {
    const connections = connectionSettings();
    const browserMap = browserMapConfig();
    const [items, sessions] = await Promise.all([
      repository.listItems(user.id),
      repository.sessions(user.id),
    ]);
    return {
      user_id: user.id,
      location: user.selectedLocation,
      items,
      sessions,
      connections,
      mapPreview: user.selectedLocation ? null : jaipurMapPreview(),
      browserMap,
      configured: {
        gemini: connections.meteredEnabled && connections.keys.gemini,
        maps: connections.meteredEnabled && connections.keys.maps,
        browserMap: !!browserMap,
      },
    };
  });
}
