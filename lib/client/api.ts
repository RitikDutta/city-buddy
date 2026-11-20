import type { Incoming, Session } from "../contracts";

export async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch("/api/" + path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    ...(data === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error || "CityBuddy could not complete this request.",
    );
  return result as T;
}
export interface InputProvider {
  send(input: Incoming, progress: (text: string) => void): Promise<Session>;
}
export class TextInputProvider implements InputProvider {
  async send(
    input: Incoming,
    progress: (text: string) => void,
  ): Promise<Session> {
    const response = await fetch(
      "/api/sessions/" + input.session_id + "/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        credentials: "same-origin",
        body: JSON.stringify(input),
      },
    );
    if (!response.ok || !response.body)
      throw new Error(
        (await response.json()).error || "Your message could not be sent.",
      );
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += value ?? "";
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "progress") progress(event.text);
          if (event.type === "error") throw new Error(event.error);
          if (event.type === "done") return event.session as Session;
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
    throw new Error(
      "The connection closed before the reply arrived. Retry your message.",
    );
  }
}
export const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please try again.";
