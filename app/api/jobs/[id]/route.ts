import type { NextRequest } from "next/server";
import { routeId, withUser, type RouteId } from "@/lib/server/http";
import { cancelJob, getJob } from "@/lib/server/outing/jobs";

export function GET(req: NextRequest, ctx: RouteId) {
  return withUser(req, async (user) => ({
    job: await getJob(user.id, await routeId(ctx)),
  }));
}
export function DELETE(req: NextRequest, ctx: RouteId) {
  return withUser(req, async (user) => ({
    job: await cancelJob(user.id, await routeId(ctx)),
  }));
}
