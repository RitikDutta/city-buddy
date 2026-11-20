"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ExternalLink, MapPin, Send, Square } from "lucide-react";
import { modeInfo, type Mode, type Session } from "@/lib/contracts";
import { api, errorText, TextInputProvider } from "@/lib/client/api";
import { Sources } from "./location-form";
import { ErrorNote, Spinner, modeIcons } from "./ui";
import { useWorkspace } from "./workspace";
import { MapPanel, RouteCard } from "./map-panel";

const prompts: Record<Mode, string[]> = {
  my_items: ["What items are pending?", "Where can I buy my items nearby?"],
  live_talk: ["Show nearby tourist places.", "Find cafés around here."],
  on_site_guide: ["Tell me about this place.", "What else can I visit nearby?"],
};
function RichText({ value }: { value: string }) {
  const plain = value.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1");
  return (
    <div className="message-text">
      {plain
        .split(/\n+/)
        .filter(Boolean)
        .map((line, i) => (
          <p key={i}>
            {line
              .replace(/^#{1,5}\s+/, "")
              .replace(/^[-*]\s+/, "• ")
              .split(/(\*\*[^*]+\*\*)/g)
              .map((part, j) =>
                part.startsWith("**") ? (
                  <strong key={j}>{part.slice(2, -2)}</strong>
                ) : (
                  part
                ),
              )}
          </p>
        ))}
    </div>
  );
}
export function ChatRoom({
  mode,
  sessionId,
}: {
  mode: Mode;
  sessionId?: string;
}) {
  const { data, refresh, changeLocation, connections } = useWorkspace();
  const [session, setSession] = useState<Session | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [overrideId, setOverrideId] = useState<string>();
  const attempted = useRef<{
    message: string;
    id: string;
    session: string;
  } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const compose = useRef<HTMLTextAreaElement>(null);
  const sessionRef = useRef<string | null>(null);
  const userId = data?.user_id;
  const locationId = data?.location?.place_id;
  const target = overrideId ?? sessionId;
  const Icon = modeIcons[mode];
  useEffect(() => {
    if (!userId) return;
    let active = true;
    setError("");
    setSession(null);
    setSelected(null);
    sessionRef.current = null;
    const loading = target
      ? api<{ session: Session }>("sessions/" + target)
      : api<{ session: Session }>("sessions", "POST", { mode });
    void loading
      .then(({ session: s }) => {
        if (!active) return;
        if (s.mode !== mode)
          throw new Error("This conversation belongs to a different mode.");
        setSession(s);
        sessionRef.current = s.id;
        setSelected(s.context.focus?.place_id ?? null);
        void refresh().catch(() => {});
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
      sessionRef.current = null;
    };
  }, [mode, target, userId, locationId, reload, refresh]);
  useEffect(() => {
    const parent = bottom.current?.parentElement;
    if (parent) parent.scrollTop = parent.scrollHeight;
  }, [session?.messages.length, busy, pending]);
  const pick = useCallback((id: string) => {
    setSelected(id);
    const card = document.getElementById("place-" + id);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const message = draft.trim();
    if (!message || !session || !data || busy) return;
    if (
      !attempted.current ||
      attempted.current.message !== message ||
      attempted.current.session !== session.id
    )
      attempted.current = {
        message,
        session: session.id,
        id: crypto.randomUUID(),
      };
    setError("");
    setPending(message);
    setBusy("Sending your message");
    const current = session.id;
    try {
      const next = await new TextInputProvider().send(
        {
          user_id: data.user_id,
          session_id: current,
          request_id: attempted.current.id,
          mode,
          message,
          location: session.location,
        },
        (text) => {
          if (sessionRef.current === current) setBusy(text);
        },
      );
      if (sessionRef.current === current) {
        setSession(next);
        setSelected(next.context.focus?.place_id ?? null);
        setDraft("");
        attempted.current = null;
      }
      await refresh();
    } catch (e) {
      if (sessionRef.current === current) setError(errorText(e));
    } finally {
      setBusy("");
      setPending("");
    }
  };
  const end = async () => {
    if (!session || busy) return;
    setBusy("Ending session");
    setError("");
    try {
      const next = await api<{ session: Session }>(
        "sessions/" + session.id + "/end",
        "POST",
      );
      setSession(next.session);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const start = async () => {
    setBusy("Opening session");
    setError("");
    try {
      const { session: s } = await api<{ session: Session }>(
        "sessions",
        "POST",
        { mode },
      );
      setOverrideId(s.id);
      setSession(s);
      setDraft("");
      setSelected(null);
      window.history.replaceState(
        null,
        "",
        modeInfo[mode].path + "?session=" + s.id,
      );
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const needsLocation = !data?.location && mode !== "my_items";
  if (!session)
    return error ? (
      <ErrorNote>
        {error}{" "}
        <button className="text-button" onClick={() => setReload((n) => n + 1)}>
          Retry
        </button>
      </ErrorNote>
    ) : (
      <div className="soft-empty" role="status">
        <Spinner />
        Opening conversation…
      </div>
    );
  const ended = session.status === "ended";
  return (
    <div className="chat-layout">
      <section className="panel chat-panel">
        <div className="chat-head">
          <div>
            <Icon size={18} />
            <strong>{modeInfo[mode].name}</strong>
          </div>
          {!ended && (
            <button
              className="subtle-button"
              disabled={!!busy}
              onClick={() => void end()}
            >
              <Square size={12} />
              End Session
            </button>
          )}
        </div>
        <div className="chat-location">
          <MapPin size={14} />
          {session.location?.name ?? "No location set"}
          {!ended && (
            <button className="text-button" onClick={changeLocation}>
              {session.location ? "Change Location" : "Set Location"}
            </button>
          )}
        </div>
        <div className="chat-scroll" role="log" aria-live="polite">
          {!session.messages.length && !pending && (
            <div className="chat-empty">
              <span className={"empty-icon " + mode}>
                <Icon size={28} />
              </span>
              <h2>
                {mode === "my_items"
                  ? "What’s on your list?"
                  : mode === "on_site_guide"
                    ? "Get to know this place"
                    : "Where shall we explore?"}
              </h2>
              <p>
                {needsLocation
                  ? "Choose a location to ask about the places around you."
                  : mode === "my_items"
                    ? "Ask about pending items or find shops near your selected location."
                    : "Ask in English, Hindi, or Hinglish."}
              </p>
              {needsLocation && !ended ? (
                <button className="secondary" onClick={changeLocation}>
                  <MapPin size={15} />
                  Set Location
                </button>
              ) : (
                !ended && (
                  <div className="chat-prompts">
                    {prompts[mode].map((p) => (
                      <button
                        key={p}
                        onClick={() => {
                          setDraft(p);
                          compose.current?.focus();
                        }}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
          )}
          {session.messages.map((m) => (
            <article key={m.id} className={"message " + m.role}>
              <small>{m.role === "user" ? "You" : "CityBuddy"}</small>
              <RichText value={m.content} />
              {m.metadata && (
                <>
                  {m.metadata.history_excerpt && (
                    <blockquote className="source-excerpt">
                      {m.metadata.history_excerpt}
                    </blockquote>
                  )}
                  <Sources values={m.metadata.sources} />
                  {m.metadata.save_url && (
                    <a
                      className="source-link"
                      href={m.metadata.save_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open places in Google Maps <ExternalLink size={12} />
                    </a>
                  )}
                  {m.metadata.routes.map((r, i) => (
                    <RouteCard key={i} route={r} />
                  ))}
                </>
              )}
            </article>
          ))}
          {pending && (
            <article className="message user">
              <small>You</small>
              <p>{pending}</p>
            </article>
          )}
          {busy && (
            <div className="working" role="status">
              <Spinner />
              {busy}…
            </div>
          )}
          <div ref={bottom} />
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        {ended ? (
          <div className="ended">
            <p>This session has ended.</p>
            <button
              className="primary"
              onClick={() => void start()}
              disabled={!!busy}
            >
              Start a new session
            </button>
          </div>
        ) : (
          <div className="composer-wrap">
            {data && !data.configured.gemini && (
              <div className="setup-note">
                Gemini needs an API key to chat.{" "}
                <button onClick={connections}>View setup</button>
              </div>
            )}
            <form className="composer" onSubmit={send}>
              <textarea
                ref={compose}
                aria-label="Message CityBuddy"
                placeholder="Message CityBuddy…"
                value={draft}
                maxLength={4000}
                rows={2}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <button
                className="primary send"
                disabled={!draft.trim() || !!busy}
                aria-label="Send message"
              >
                <Send size={17} />
                <span>Send</span>
              </button>
            </form>
          </div>
        )}
      </section>
      <MapPanel
        location={session.location}
        places={session.context.places}
        routes={session.context.routes}
        selected={selected}
        choose={pick}
      />
    </div>
  );
}
export function TalkPage({
  mode,
  sessionId,
}: {
  mode: Mode;
  sessionId?: string;
}) {
  const Icon = modeIcons[mode];
  return (
    <div className="inner-page">
      <div className="page-title">
        <span className={"page-icon " + mode}>
          <Icon />
        </span>
        <div>
          <h1>{modeInfo[mode].name}</h1>
          <p>{modeInfo[mode].description}</p>
        </div>
      </div>
      <ChatRoom mode={mode} sessionId={sessionId} />
    </div>
  );
}
