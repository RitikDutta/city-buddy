import type { NextRequest } from "next/server";
import { withUser } from "@/lib/server/http";
import { getTrip } from "@/lib/server/outing/trips";

export function GET(req: NextRequest) {
  return withUser(req, async (user) => ({ trip: await getTrip(user.id) }));
}
