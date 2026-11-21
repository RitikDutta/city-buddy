export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "request_failed",
  ) {
    super(message);
  }
}
// Gemini supplies a RetryInfo duration and quota dimensions with HTTP 429.
export function rateLimitWait(error: unknown): number | undefined {
  const api = error as { status?: number; message?: string } | undefined;
  if (api?.status !== 429 || !api.message) return;
  try {
    const response = JSON.parse(api.message).error as {
      message?: string;
      details?: {
        retryDelay?: string;
        violations?: { quotaId?: string; quotaValue?: string }[];
      }[];
    };
    const details = response.details ?? [];
    const violations = details.flatMap((entry) => entry.violations ?? []);
    if (
      violations.some(
        (v) => /perday|permonth/i.test(v.quotaId ?? "") || v.quotaValue === "0",
      ) ||
      /limit:\s*0\b/i.test(response.message ?? "")
    )
      return;
    const delay = details.find((entry) => entry.retryDelay)?.retryDelay;
    const seconds = delay && /^(\d+(?:\.\d+)?)s$/.exec(delay);
    if (seconds && Number(seconds[1]) <= 65)
      return Math.ceil(Number(seconds[1])) + 1;
  } catch {
    // Other providers can send a plain-text quota error.
  }
}
export const notFound = () =>
  new AppError(404, "This record could not be found.", "not_found");
export const conflict = (message: string) =>
  new AppError(409, message, "conflict");
export function missingProvider(service: "maps" | "gemini") {
  return service === "maps"
    ? new AppError(
        503,
        "Google Maps MCP needs a server key. Set google_map_api_city_buddy or GOOGLE_MAPS_API_KEY to search for places.",
        "maps_not_configured",
      )
    : new AppError(
        503,
        "The AI agent needs a Gemini key. Set GEMINI_API_KEY in .env.local to start chatting.",
        "gemini_not_configured",
      );
}
export function providerError(service: string, error: unknown) {
  if (error instanceof AppError) return error;
  const details = error as {
    status?: number;
    statusCode?: number;
    message?: string;
    name?: string;
  };
  const message = details?.message ?? "";
  const status = details?.status ?? details?.statusCode;
  if (status === 429 || /429|RESOURCE_EXHAUSTED/i.test(message))
    return new AppError(
      429,
      service +
        " has reached its quota. Try again later or check the project's quota.",
      "provider_quota",
    );
  if (
    status === 401 ||
    status === 403 ||
    /401|403|API_KEY_INVALID|permission.denied|API key not valid/i.test(message)
  )
    return new AppError(
      502,
      service +
        " rejected its credentials. Check the API key, enabled service, and key restrictions.",
      "provider_auth",
    );
  if (
    status === 504 ||
    /timeout|timed out|abort|deadline.exceeded/i.test(
      message +
        details?.name +
        (error as { cause?: { code?: string } })?.cause?.code,
    )
  )
    return new AppError(
      504,
      service + " took too long to respond. Please try again.",
      "provider_timeout",
    );
  if (status === 503 || /high demand|temporarily unavailable/i.test(message))
    return new AppError(
      503,
      service + " is busy. Please retry this message in a moment.",
      "provider_busy",
    );
  return new AppError(
    502,
    service +
      " could not complete the request. Check its configuration and try again.",
    "provider_unavailable",
  );
}
