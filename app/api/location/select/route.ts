import type { NextRequest } from "next/server";
import { z } from "zod";
import { body, withUser } from "@/lib/server/http";
import { repository } from "@/lib/server/repository";

export function POST(req: NextRequest) {
  return withUser(req, async (user) => {
    const { place_id } = await body(
      req,
      z.object({ place_id: z.string().min(1).max(500) }).strict(),
    );
    return { location: await repository.selectLocation(user.id, place_id) };
  });
}
