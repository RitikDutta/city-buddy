import type { NextRequest } from "next/server";
import { z } from "zod";
import { nearbyInput } from "@/lib/outing-contracts";
import { body, withUser } from "@/lib/server/http";
import { notFound } from "@/lib/server/errors";
import { db } from "@/lib/server/db";
import { localCatalog } from "@/lib/server/outing/catalog";
import { nearbyForUser, queuePreparation } from "@/lib/server/outing/context";

export function GET(req: NextRequest) {
  return withUser(req, (user) =>
    nearbyForUser(
      user.id,
      nearbyInput.parse({
        query: req.nextUrl.searchParams.get("q") ?? "",
        explore: true,
      }),
    ),
  );
}
export function POST(req: NextRequest) {
  return withUser(req, async (user) => {
    const placeId = z.string().min(1).max(180);
    const event = await body(
      req,
      z.union([
        z.object({ placeId, action: z.enum(["shown", "dismissed"]) }).strict(),
        z
          .object({
            placeIds: z.array(placeId).min(1).max(30),
            action: z.literal("shown"),
          })
          .strict(),
      ]),
    );
    const ids =
      "placeIds" in event ? [...new Set(event.placeIds)] : [event.placeId];
    const known = new Set(localCatalog.entries().map((row) => row.place_id));
    if (ids.some((id) => !known.has(id))) throw notFound();
    await db.$transaction(async (tx) => {
      await tx.recommendationEvent.createMany({
        data: ids.map((placeId) => ({
          userId: user.id,
          placeId,
          action: event.action,
        })),
      });
      if (event.action === "dismissed") await queuePreparation(tx, user.id);
    });
    return { ok: true };
  });
}
