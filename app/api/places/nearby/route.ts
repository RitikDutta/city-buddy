import type { NextRequest } from "next/server";
import { nearbyInput } from "@/lib/outing-contracts";
import { withUser } from "@/lib/server/http";
import { nearbyForUser } from "@/lib/server/outing/context";

export function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  return withUser(req, (user) =>
    nearbyForUser(
      user.id,
      nearbyInput.parse({
        query: params.get("q") ?? "",
        categories: params.getAll("category"),
        radius: params.has("radius") ? Number(params.get("radius")) : undefined,
        limit: params.has("limit") ? Number(params.get("limit")) : undefined,
        explore: params.get("explore") === "1",
      }),
    ),
  );
}
