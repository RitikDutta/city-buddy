import type { NextRequest } from "next/server";
import { z } from "zod";
import { withUser } from "@/lib/server/http";
import { notFound } from "@/lib/server/errors";
import { localCatalog } from "@/lib/server/outing/catalog";

export function GET(req: NextRequest) {
  return withUser(req, async () => {
    const id = z
      .string()
      .min(1)
      .max(180)
      .parse(req.nextUrl.searchParams.get("id"));
    const place = localCatalog.entries().find((row) => row.place_id === id);
    if (!place) throw notFound();
    return { place };
  });
}
