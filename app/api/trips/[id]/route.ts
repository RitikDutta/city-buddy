import type { NextRequest } from "next/server";
import { routeId, withUser, type RouteId } from "@/lib/server/http";
import { getTrip } from "@/lib/server/outing/trips";

export function GET(req: NextRequest, ctx: RouteId) {
  return withUser(req, async (user) => ({
    trip: await getTrip(user.id, await routeId(ctx)),
  }));
}
