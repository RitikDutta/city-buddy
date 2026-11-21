import type { NextRequest } from "next/server";
import { planInput } from "@/lib/outing-contracts";
import { body, withUser } from "@/lib/server/http";
import { db } from "@/lib/server/db";
import { createTrip } from "@/lib/server/outing/trips";

export function POST(req: NextRequest) {
  return withUser(req, async (user) => {
    const input = await body(req, planInput);
    const start = performance.now();
    const trip = await db.$transaction((tx) => createTrip(tx, user.id, input));
    return { trip, durationMs: Math.round(performance.now() - start) };
  });
}
