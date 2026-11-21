import type { NextRequest } from "next/server";
import { withUser } from "@/lib/server/http";
import { db } from "@/lib/server/db";
import {
  getPreparation,
  loadPreferences,
  queuePreparation,
} from "@/lib/server/outing/context";
import { getTrip } from "@/lib/server/outing/trips";

export function GET(req: NextRequest) {
  return withUser(req, async (user) => {
    const [preferences, trip, preparation] = await Promise.all([
      loadPreferences(db, user.id),
      getTrip(user.id),
      getPreparation(user.id),
    ]);
    return {
      preferences,
      trip,
      ...preparation,
      simulator:
        process.env.NODE_ENV !== "production" ||
        process.env.CITYBUDDY_SIMULATOR === "1",
    };
  });
}
export function POST(req: NextRequest) {
  return withUser(req, async (user) => {
    const job = await db.$transaction((tx) => queuePreparation(tx, user.id));
    return { jobId: job?.id ?? null };
  });
}
