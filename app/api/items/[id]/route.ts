import type { NextRequest } from "next/server";
import { updateItemSchema } from "@/lib/contracts";
import { body, withUser, routeId, type RouteId } from "@/lib/server/http";
import { repository } from "@/lib/server/repository";

export function PATCH(req: NextRequest, ctx: RouteId) {
  return withUser(req, async (user) => ({
    item: await repository.editItem(
      user.id,
      await routeId(ctx),
      await body(req, updateItemSchema),
    ),
  }));
}
export function DELETE(req: NextRequest, ctx: RouteId) {
  return withUser(req, async (user) => {
    await repository.removeItem(user.id, await routeId(ctx));
    return { deleted: true };
  });
}
