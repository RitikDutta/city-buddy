import type { NextRequest } from "next/server";
import { z } from "zod";
import { withUser, body } from "@/lib/server/http";
import { ManualLocationProvider } from "@/lib/server/location";
import { repository } from "@/lib/server/repository";

export function POST(req: NextRequest) {
  return withUser(req, async (user) => {
    const { query } = await body(
      req,
      z.object({ query: z.string().trim().min(2).max(1200) }).strict(),
    );
    const choices = await new ManualLocationProvider().resolve(
      query,
      req.signal,
    );
    await repository.rememberChoices(user.id, choices);
    return { choices };
  });
}
