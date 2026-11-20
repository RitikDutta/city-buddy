import type { NextRequest } from "next/server";
import { withUser, routeId, type RouteId } from "@/lib/server/http";
import { repository } from "@/lib/server/repository";

export function POST(req: NextRequest, ctx: RouteId) {
  return withUser(req, async (user) => ({
    session: await repository.endSession(user.id, await routeId(ctx)),
  }));
}
