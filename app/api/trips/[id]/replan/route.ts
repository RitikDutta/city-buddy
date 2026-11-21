import type { NextRequest } from "next/server";
import { replanInput } from "@/lib/outing-contracts";
import { body, routeId, withUser, type RouteId } from "@/lib/server/http";
import { db } from "@/lib/server/db";
import { replanTrip } from "@/lib/server/outing/trips";

export function POST(req: NextRequest, ctx: RouteId) {
  return withUser(req, async (user) => {
    const id = await routeId(ctx);
    const input = await body(req, replanInput);
    return {
      trip: await db.$transaction((tx) => replanTrip(tx, user.id, id, input)),
    };
  });
}
