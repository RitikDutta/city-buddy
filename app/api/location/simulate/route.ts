import { z } from "zod";
import type { NextRequest } from "next/server";
import { simulatedLocation } from "@/lib/outing-contracts";
import { body, withUser } from "@/lib/server/http";
import { coordinateLocation } from "@/lib/server/outing/catalog";
import { getTrip } from "@/lib/server/outing/trips";
import { notFound } from "@/lib/server/errors";
import { repository } from "@/lib/server/repository";

const input = z.union([
  simulatedLocation,
  z.object({ tripId: z.uuid(), stopId: z.uuid() }).strict(),
]);
export function POST(req: NextRequest) {
  return withUser(req, async (user) => {
    const value = await body(req, input);
    if ("tripId" in value) {
      const trip = await getTrip(user.id, value.tripId);
      const place = trip?.stops.find((stop) => stop.id === value.stopId)?.place;
      if (!place || place.latitude === null || place.longitude === null)
        throw notFound();
      return {
        location: await repository.updateLocation(user.id, {
          ...place,
          latitude: place.latitude,
          longitude: place.longitude,
          source: "manual",
        }),
      };
    }
    return {
      location: await repository.updateLocation(
        user.id,
        coordinateLocation(value.latitude, value.longitude, value.name),
      ),
    };
  });
}
