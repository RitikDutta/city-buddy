import type { NextRequest } from "next/server";
import { z } from "zod";
import { modeSchema } from "@/lib/contracts";
import { body, withUser } from "@/lib/server/http";
import { repository } from "@/lib/server/repository";

export function POST(req: NextRequest) {
  return withUser(req, async (user) => {
    const { mode } = await body(req, z.object({ mode: modeSchema }).strict());
    return { session: await repository.openSession(user.id, mode) };
  });
}
