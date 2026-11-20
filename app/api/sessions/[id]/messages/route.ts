import type { NextRequest } from "next/server";
import { incomingSchema } from "@/lib/contracts";
import { runTurn } from "@/lib/server/agent";
import {
  body,
  withUser,
  errorInfo,
  routeId,
  type RouteId,
} from "@/lib/server/http";
import { AppError } from "@/lib/server/errors";

export const maxDuration = 175;
export function POST(req: NextRequest, ctx: RouteId) {
  return withUser(req, async (user) => {
    const id = await routeId(ctx);
    const input = await body(req, incomingSchema);
    if (input.session_id !== id)
      throw new AppError(400, "The message must belong to this session.");
    if (!req.headers.get("accept")?.includes("application/x-ndjson"))
      return { session: await runTurn(user.id, input, { signal: req.signal }) };
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: unknown) => {
          if (!req.signal.aborted)
            controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
        };
        try {
          const session = await runTurn(user.id, input, {
            signal: req.signal,
            progress: (text) => send({ type: "progress", text }),
          });
          send({ type: "done", session });
        } catch (err) {
          send({ type: "error", ...errorInfo(err) });
        } finally {
          if (!req.signal.aborted) controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
