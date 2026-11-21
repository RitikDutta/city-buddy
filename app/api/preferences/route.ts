import type { NextRequest } from "next/server";
import { preferencesSchema } from "@/lib/outing-contracts";
import { body, withUser } from "@/lib/server/http";
import { db } from "@/lib/server/db";
import { loadPreferences, savePreferences } from "@/lib/server/outing/context";

export function GET(req: NextRequest) {
  return withUser(req, async (user) => ({
    preferences: await loadPreferences(db, user.id),
  }));
}
export function PATCH(req: NextRequest) {
  return withUser(req, async (user) => ({
    preferences: await savePreferences(
      user.id,
      await body(req, preferencesSchema),
    ),
  }));
}
