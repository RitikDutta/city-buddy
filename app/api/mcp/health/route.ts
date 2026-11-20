import { NextResponse } from "next/server";
import { failure } from "@/lib/server/http";
import { openMaps, supported } from "@/lib/server/maps";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const connection = await openMaps();
    try {
      const tools = connection.tools.map((t) => t.name);
      const missing = supported.filter((n) => !tools.includes(n));
      if (missing.length)
        return NextResponse.json(
          {
            ok: false,
            tools,
            missing,
            error: "Maps MCP is missing a required tool.",
          },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      // Google can allow tool discovery while denying the key access to place data.
      await connection.call("resolve_names", {
        queries: [{ text: "Mansarovar, Jaipur" }],
      });
      return NextResponse.json(
        { ok: true, tools, missing },
        { headers: { "Cache-Control": "no-store" } },
      );
    } finally {
      await connection.close();
    }
  } catch (err) {
    return failure(err);
  }
}
