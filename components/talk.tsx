"use client";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ListChecks,
  MapPin,
  Send,
  Square,
} from "lucide-react";
import {
  modeInfo,
  type Mode,
  type Place,
  type RouteResult,
  type Session,
} from "@/lib/contracts";
import { api, errorText, TextInputProvider } from "@/lib/client/api";
import { Sources } from "./location-form";
import { ErrorNote, Modal, Spinner, modeIcons } from "./ui";
import { useWorkspace } from "./workspace";
import { MapPanel, RouteCard } from "./map-panel";

const prompts: Record<Mode, string[]> = {
  my_items: ["What items are pending?", "Where can I buy my items nearby?"],
  live_talk: ["Show nearby tourist places.", "Find cafés around here."],
  on_site_guide: ["Tell me about this place.", "What else can I visit nearby?"],
};
const savedGuideFollowUps = [
  {
    question: "Would you like to explore nearby landmarks?",
    prompt: "Show me nearby landmarks.",
  },
  {
    question: "क्या आप आस-पास की जगहें देखना चाहेंगे?",
    prompt: "आस-पास की जगहें दिखाएँ।",
  },
];
const emptyPlaces: Place[] = [];
const emptyRoutes: RouteResult[] = [];
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
  checklist,
}: {
  mode: Mode;
  sessionId?: string;
  checklist?: ReactNode;
}) {
  const { data, refresh, changeLocation } = useWorkspace();
  const [session, setSession] = useState<Session | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [overrideId, setOverrideId] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);
  const [showChecklist, setShowChecklist] = useState(false);
  const [mapInset, setMapInset] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const transcriptId = useId();
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
    const area = stage.current;
    const sheet = panel.current;
    if (!area || !sheet) return;
    const measure = () => {
      setMapInset(
        Math.ceil(
          area.getBoundingClientRect().bottom -
            sheet.getBoundingClientRect().top,
        ),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    observer.observe(sheet);
    measure();
    return () => observer.disconnect();
  }, []);
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
    if (!parent || parent.hidden) return;
    const latest = parent.querySelector<HTMLElement>(
      "article.message:last-of-type",
    );
    parent.scrollTop =
      !busy &&
      latest?.classList.contains("assistant") &&
      latest.offsetHeight > parent.clientHeight
        ? latest.offsetTop - 8
        : parent.scrollHeight;
  }, [session?.messages.length, busy, pending, collapsed]);
  const pick = useCallback((id: string) => {
    setSelected(id);
  }, []);
  const fillDraft = (prompt: string) => {
    setDraft(prompt);
    compose.current?.focus();
  };
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
    setCollapsed(false);
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
  const ended = session?.status === "ended";
  const places = useMemo(() => {
    const current = session?.context.places ?? emptyPlaces;
    if (!session || !selected || current.some((p) => p.place_id === selected))
      return current;
    const earlier = session.messages.findLast((m) =>
      m.metadata?.places.some((p) => p.place_id === selected),
    );
    const place = earlier?.metadata?.places.find(
      (p) => p.place_id === selected,
    );
    return place ? [...current, place] : current;
  }, [session, selected]);
  return (
    <div className="module-stage" ref={stage}>
      <MapPanel
        location={session ? session.location : (data?.location ?? null)}
        places={places}
        routes={session?.context.routes ?? emptyRoutes}
        selected={selected}
        choose={pick}
        clearSelection={() => setSelected(null)}
        changeLocation={changeLocation}
        bottomInset={mapInset}
      />
      <section className="chat-panel" ref={panel} aria-label="CityBuddy chat">
        <div className="chat-head">
          <div className="chat-heading">
            <Link
              href="/"
              className="icon-button"
              aria-label="Back to overview"
              title="Back to overview"
            >
              <ArrowLeft size={19} />
            </Link>
            <span className="chat-mode-icon">
              <Icon size={17} />
            </span>
            <h1>{modeInfo[mode].name}</h1>
          </div>
          <div className="chat-actions">
            <Link
              className="icon-button"
              href="/outing"
              aria-label="Outing planner"
              title="Outing planner"
            >
              <CalendarDays size={17} />
            </Link>
            {checklist && (
              <button
                type="button"
                className="icon-button"
                aria-label="Open shopping checklist"
                title="Shopping checklist"
                onClick={() => setShowChecklist(true)}
              >
                <ListChecks size={18} />
              </button>
            )}
            {session && !ended && (
              <button
                type="button"
                className="icon-button"
                disabled={!!busy}
                aria-label="End session"
                title="End session"
                onClick={() => void end()}
              >
                <Square size={16} />
              </button>
            )}
            {session && (
              <button
                type="button"
                className="icon-button chat-toggle"
                aria-label={
                  collapsed ? "Show conversation" : "Minimize conversation"
                }
                title={
                  collapsed ? "Show conversation" : "Minimize conversation"
                }
                aria-expanded={!collapsed}
                aria-controls={transcriptId}
                onClick={() => setCollapsed(!collapsed)}
              >
                {collapsed ? (
                  <ChevronUp size={20} />
                ) : (
                  <ChevronDown size={20} />
                )}
              </button>
            )}
          </div>
        </div>
        {!session ? (
          error ? (
            <ErrorNote>
              {error}{" "}
              <button
                className="text-button"
                onClick={() => setReload((n) => n + 1)}
              >
                Retry
              </button>
            </ErrorNote>
          ) : (
            <div className="chat-loading" role="status">
              <Spinner /> Opening conversation…
            </div>
          )
        ) : (
          <>
            <div
              className="chat-scroll"
              id={transcriptId}
              role="log"
              aria-live="polite"
              hidden={collapsed}
            >
              {!session.messages.length && !pending && (
                <div className="chat-empty">
                  <h2>
                    {mode === "my_items"
                      ? "What’s on your list?"
                      : mode === "on_site_guide"
                        ? "Get to know this place"
                        : "Where shall we explore?"}
                  </h2>
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
                            type="button"
                            onClick={() => fillDraft(p)}
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    )
                  )}
                </div>
              )}
              {session.messages.map((m) => {
                const savedFollowUp =
                  m.role === "assistant" &&
                  mode === "on_site_guide" &&
                  !m.metadata?.suggestion
                    ? savedGuideFollowUps.find(({ question }) =>
                        m.content.endsWith(question),
                      )
                    : undefined;
                const prompt =
                  m.role === "assistant"
                    ? (m.metadata?.suggestion ?? savedFollowUp?.prompt)
                    : undefined;
                const canSuggest = prompt && !ended && !needsLocation;
                return (
                  <article key={m.id} className={"message " + m.role}>
                    <small>{m.role === "user" ? "You" : "CityBuddy"}</small>
                    <RichText
                      value={
                        canSuggest && savedFollowUp
                          ? m.content
                              .slice(0, -savedFollowUp.question.length)
                              .trimEnd()
                          : m.content
                      }
                    />
                    {m.metadata && (
                      <>
                        {m.metadata.providerNotice && (
                          <p className="provider-notice">
                            Local reply · {m.metadata.providerNotice}
                          </p>
                        )}
                        {m.metadata.history_excerpt && (
                          <blockquote className="source-excerpt">
                            {m.metadata.history_excerpt}
                          </blockquote>
                        )}
                        <Sources values={m.metadata.sources} />
                        {m.metadata.places.length > 0 && (
                          <details className="chat-places">
                            <summary>
                              {m.metadata.places.length === 1
                                ? "1 place on the map"
                                : m.metadata.places.length +
                                  " places on the map"}
                            </summary>
                            <ul>
                              {m.metadata.places.map((place) => (
                                <li key={place.place_id}>
                                  <button
                                    type="button"
                                    className="text-button"
                                    onClick={() => pick(place.place_id)}
                                  >
                                    <MapPin size={13} /> {place.name}
                                  </button>
                                  {place.maps_url && (
                                    <a
                                      href={place.maps_url}
                                      target="_blank"
                                      rel="noreferrer"
                                      aria-label={
                                        "Open the map listing for " + place.name
                                      }
                                    >
                                      <ExternalLink size={13} />
                                    </a>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {m.metadata.save_url && (
                          <a
                            className="source-link"
                            href={m.metadata.save_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open places in Google Maps{" "}
                            <ExternalLink size={12} />
                          </a>
                        )}
                        {m.metadata.routes.map((r, i) => (
                          <RouteCard key={i} route={r} />
                        ))}
                      </>
                    )}
                    {canSuggest && (
                      <div className="chat-prompts message-prompts">
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() => fillDraft(prompt)}
                        >
                          {prompt}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
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
                  <div className="setup-note">Local text mode</div>
                )}
                <form className="composer" onSubmit={send}>
                  <textarea
                    ref={compose}
                    aria-label="Message CityBuddy"
                    placeholder="Message CityBuddy…"
                    value={draft}
                    maxLength={4000}
                    rows={1}
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
          </>
        )}
      </section>
      {showChecklist && checklist && (
        <Modal title="Shopping checklist" close={() => setShowChecklist(false)}>
          {checklist}
        </Modal>
      )}
    </div>
  );
}
