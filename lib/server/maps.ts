import { mapsApiKey } from "./config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { AppError, missingProvider, providerError } from "./errors";
import { normalizeResult, record, resultPayload } from "./map-results";
import type { MapResult } from "../contracts";

export const supported = [
  "search_places",
  "compute_routes",
  "resolve_names",
  "resolve_maps_urls",
] as const;
export type Args = Record<string, unknown>;
export type MapsConnection = {
  tools: Tool[];
  call(name: string, args: Args, signal?: AbortSignal): Promise<MapResult>;
  close(): Promise<void>;
};

// The hosted tools describe protobuf fields in camelCase. Older schemas and
// tool descriptions use snake_case. Always send the spelling actually advertised.
function alignFields(value: unknown, schema: Args, definitions: Args): unknown {
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/$defs/"))
    schema = record(definitions[schema.$ref.slice(8)]);
  if (Array.isArray(value))
    return value.map((entry) =>
      alignFields(entry, record(schema.items), definitions),
    );
  if (!value || typeof value !== "object") return value;
  const properties = record(schema.properties);
  const fieldNames = Object.keys(properties);
  const normalized = (s: string) => s.replaceAll("_", "").toLowerCase();
  const result = new Map<string, unknown>();
  for (const [key, entry] of Object.entries(value)) {
    const field = Object.hasOwn(properties, key)
      ? key
      : (fieldNames.find((name) => normalized(name) === normalized(key)) ??
        key);
    if (result.has(field))
      throw new AppError(
        422,
        "Use a single spelling for each Maps tool argument.",
      );
    result.set(
      field,
      alignFields(entry, record(properties[field]), definitions),
    );
  }
  return Object.fromEntries(result);
}

async function connectMaps(
  key: string,
  signal?: AbortSignal,
): Promise<MapsConnection> {
  const validation = new Ajv({ strict: false, addUsedSchema: false });
  addFormats(validation);
  validation.addFormat("google-duration", /^-?\d+(?:\.\d{1,9})?s$/);
  const client = new Client(
    { name: "citybuddy", version: "1.0.0" },
    { jsonSchemaValidator: new AjvJsonSchemaValidator(validation) },
  );
  try {
    const url = new URL(
      process.env.GOOGLE_MAPS_MCP_URL || "https://mapstools.googleapis.com/mcp",
    );
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { "X-Goog-Api-Key": key }, redirect: "error" },
      fetch: (input, init) => {
        const timeout = AbortSignal.timeout(
          init?.method === "DELETE" ? 2000 : 35_000,
        );
        return fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, timeout])
            : timeout,
        });
      },
    });
    const deadline = AbortSignal.timeout(25_000);
    const discoverySignal = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    await client.connect(transport, {
      timeout: 18_000,
      signal: discoverySignal,
    });
    const tools: Tool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: 18_000,
        signal: discoverySignal,
      });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size > 16))
        throw new AppError(
          502,
          "Maps tool discovery could not finish.",
          "maps_schema_error",
        );
      if (cursor) seen.add(cursor);
    } while (cursor);
    const validators = new Map(
      tools
        .filter((t) => supported.some((name) => name === t.name))
        .map((tool) => {
          const schema = { ...tool.inputSchema };
          delete schema.$schema;
          return [
            tool.name,
            { schema, validate: validation.compile(schema) },
          ] as const;
        }),
    );
    return {
      tools,
      async call(name, args, abort) {
        const tool = validators.get(name);
        const wire = tool
          ? record(alignFields(args, tool.schema, record(tool.schema.$defs)))
          : {};
        if (!tool || !tool.validate(wire))
          throw new AppError(
            422,
            "The arguments do not match the available " +
              name +
              " tool. Use its discovered schema.",
            "invalid_tool_arguments",
          );
        try {
          const result = await client.callTool(
            { name, arguments: wire },
            undefined,
            { timeout: 35_000, signal: abort ?? signal },
          );
          return normalizeResult(name, resultPayload(result), wire);
        } catch (err) {
          throw providerError("Google Maps MCP", err);
        }
      },
      async close() {
        try {
          if (transport.sessionId) await transport.terminateSession();
        } catch {
          /* Stateless endpoints may have no session to terminate. */
        }
        await client.close();
      },
    };
  } catch (err) {
    await client.close().catch(() => {});
    throw providerError("Google Maps MCP", err);
  }
}

export async function openMaps(signal?: AbortSignal): Promise<MapsConnection> {
  const key = mapsApiKey();
  if (!key) throw missingProvider("maps");
  const fallbackKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!fallbackKey || fallbackKey === key) return connectMaps(key, signal);

  const denied = (error: unknown) =>
    error instanceof AppError && error.code === "provider_auth";
  let primary: MapsConnection;
  try {
    primary = await connectMaps(key, signal);
  } catch (error) {
    if (!denied(error)) throw error;
    return connectMaps(fallbackKey, signal);
  }

  const deniedTools = new Set<string>();
  let fallback: Promise<MapsConnection> | undefined;
  return {
    tools: primary.tools,
    async call(name, args, abort) {
      if (!deniedTools.has(name)) {
        try {
          return await primary.call(name, args, abort);
        } catch (error) {
          if (!denied(error)) throw error;
          deniedTools.add(name);
        }
      }
      fallback ??= connectMaps(fallbackKey, abort ?? signal).catch((error) => {
        fallback = undefined;
        throw error;
      });
      const connection = await fallback;
      return connection.call(name, args, abort);
    },
    async close() {
      await Promise.allSettled([
        primary.close(),
        fallback?.then((c) => c.close()),
      ]);
    },
  };
}
