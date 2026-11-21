import { NextResponse } from "next/server";
import { metrics } from "@/lib/server/metrics";

export function GET() {
  return process.env.NODE_ENV === "development"
    ? NextResponse.json(metrics(), { headers: { "Cache-Control": "no-store" } })
    : new Response(null, { status: 404 });
}
