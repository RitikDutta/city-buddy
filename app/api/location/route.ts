import { z } from "zod";
import type { NextRequest } from "next/server";
import { simulatedLocation } from "@/lib/outing-contracts";
import { body, withUser } from "@/lib/server/http";
import { coordinateLocation } from "@/lib/server/outing/catalog";
import { repository } from "@/lib/server/repository";

const input = z.union([
  simulatedLocation,
  z.object({ place_id: z.string().min(1).max(500) }).strict(),
  z.object({ clear: z.literal(true) }).strict(),
]);
export function PATCH(req: NextRequest) {
  return withUser(req, async (user) => {
    const value = await body(req, input);
    const location =
      "place_id" in value
        ? await repository.selectLocation(user.id, value.place_id)
        : await repository.updateLocation(
            user.id,
            "clear" in value
              ? null
              : coordinateLocation(value.latitude, value.longitude, value.name),
          );
    return { location };
  });
}
