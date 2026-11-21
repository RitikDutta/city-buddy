import type { NextRequest } from "next/server";
import { z } from "zod";
import { withUser, body } from "@/lib/server/http";
import { ManualLocationProvider } from "@/lib/server/location";
import { repository } from "@/lib/server/repository";
import { mapsApiKey } from "@/lib/server/config";
import { resolveLocal } from "@/lib/server/outing/catalog";
import { AppError } from "@/lib/server/errors";

export function POST(req: NextRequest) {
  return withUser(req, async (user) => {
    const { query } = await body(
      req,
      z.object({ query: z.string().trim().min(2).max(1200) }).strict(),
    );
    const providerEnabled = !!mapsApiKey();
    if (/^https?:/i.test(query) && !providerEnabled) {
      throw new AppError(
        400,
        "Use a local place name or coordinates. Map links require the optional Google provider.",
      );
    }
    let choices = resolveLocal(query);
    if (providerEnabled && !choices[0]?.place_id.startsWith("coordinate:")) {
      try {
        const remote = await new ManualLocationProvider().resolve(
          query,
          req.signal,
        );
        if (remote.length) choices = remote;
      } catch (error) {
        if (
          !choices.length ||
          !(error instanceof AppError) ||
          req.signal.aborted
        )
          throw error;
      }
    }
    await repository.rememberChoices(user.id, choices);
    return { choices };
  });
}
