import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { User } from "@prisma/client";
import { repository } from "./repository";
import { AppError } from "./errors";
import { recordMetric } from "./metrics";

export type RouteId = { params: Promise<{ id: string }> };
export async function routeId(ctx: RouteId) {
  return z.uuid().parse((await ctx.params).id);
}
export function errorInfo(error: unknown) {
  if (error instanceof AppError)
    return { status: error.status, error: error.message, code: error.code };
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return {
      status: 400,
      error:
        (issue.path.length ? issue.path.join(".") + " — " : "") + issue.message,
      code: "invalid_input",
    };
  }
  if (error instanceof Error && /TimeoutError|AbortError/.test(error.name))
    return {
      status: 504,
      error: "The request timed out. Please try again.",
      code: "timeout",
    };
  return {
    status: 500,
    error: "CityBuddy could not finish the request. Please try again.",
    code: "internal_error",
  };
}
export function failure(error: unknown) {
  const { status, ...body } = errorInfo(error);
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export async function body<T>(
  req: NextRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!req.headers.get("content-type")?.includes("application/json"))
    throw new AppError(415, "Send a JSON request.");
  if (Number(req.headers.get("content-length")) > 32000)
    throw new AppError(413, "This request is too large.");
  const raw = await req.text();
  if (raw.length > 32000) throw new AppError(413, "This request is too large.");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AppError(400, "The request body must be valid JSON.");
  }
  return schema.parse(data);
}
export async function withUser(
  req: NextRequest,
  handler: (user: User) => Promise<unknown>,
) {
  let token: string | null = null;
  let response: Response;
  try {
    const origin = req.headers.get("origin");
    if (
      req.method !== "GET" &&
      origin &&
      new URL(origin).host !== req.headers.get("host")
    )
      throw new AppError(
        403,
        "This request must come from the CityBuddy application.",
      );
    const start = performance.now();
    const identity = await repository.identity(
      req.cookies.get("citybuddy_identity")?.value,
    );
    recordMetric("database_identity", performance.now() - start);
    token = identity.token;
    const data = await handler(identity.user);
    response = data instanceof Response ? data : NextResponse.json(data);
  } catch (e) {
    response = failure(e);
  }
  response.headers.set("Cache-Control", "no-store");
  if (token)
    response.headers.append(
      "Set-Cookie",
      "citybuddy_identity=" +
        token +
        "; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000" +
        (req.nextUrl.protocol === "https:" ? "; Secure" : ""),
    );
  return response;
}
