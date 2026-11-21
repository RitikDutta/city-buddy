import type { NextRequest } from "next/server";
import { incomingSchema } from "@/lib/contracts";
import { body, withUser } from "@/lib/server/http";
import { runTurn } from "@/lib/server/agent";

export function POST(req: NextRequest) {
  return withUser(req, async (user) => ({
    session: await runTurn(user.id, await body(req, incomingSchema), {
      signal: req.signal,
    }),
  }));
}
