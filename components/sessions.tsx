"use client";
import Link from "next/link";
import { History } from "lucide-react";
import { modeInfo, type SessionSummary } from "@/lib/contracts";
import { modeIcons, Spinner } from "./ui";
import { useWorkspace } from "./workspace";

export function SessionRows({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <div className="session-list">
      {sessions.map((s) => {
        const Icon = modeIcons[s.mode];
        return (
          <Link
            key={s.id}
            href={modeInfo[s.mode].path + "?session=" + s.id}
            className="session-row"
          >
            <span className={"mode-icon " + s.mode}>
              <Icon size={19} />
            </span>
            <span className="session-title">
              <strong>{s.title || modeInfo[s.mode].name}</strong>
              <small>
                {modeInfo[s.mode].name} · {s.message_count} messages
                {s.location ? " · " + s.location.name : ""}
              </small>
            </span>
            <span className="session-date">
              {new Date(s.updated_at).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
            <span className="status-label">
              {s.status === "ended" ? "Ended" : "Active"}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
export function HistoryPage() {
  const { data } = useWorkspace();
  return (
    <div className="inner-page">
      <div className="page-title">
        <span className="page-icon">
          <History />
        </span>
        <div>
          <h1>Session history</h1>
          <p>Revisit your conversations and the places you explored.</p>
        </div>
      </div>
      {!data ? (
        <div className="soft-empty">
          <Spinner />
          Loading sessions…
        </div>
      ) : data.sessions.length ? (
        <SessionRows sessions={data.sessions} />
      ) : (
        <div className="panel empty">
          <History size={32} />
          <h2>No sessions yet</h2>
          <p>
            Your conversations will appear here when you open an assistant mode.
          </p>
          <Link className="secondary" href="/talk">
            Open Live Talk
          </Link>
        </div>
      )}
    </div>
  );
}
