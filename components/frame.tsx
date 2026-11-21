"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Cable,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Compass,
  History,
  LayoutGrid,
  MapPin,
  Menu,
  PlugZap,
  X,
} from "lucide-react";
import { modes, modeInfo, type Workspace } from "@/lib/contracts";
import { api, errorText } from "@/lib/client/api";
import { WorkspaceContext } from "./workspace";
import { LocationForm } from "./location-form";
import { ErrorNote, Modal, Spinner, modeIcons } from "./ui";

let starting: Promise<Workspace> | null = null;
function bootstrap() {
  starting ??= api<Workspace>("workspace").finally(() => {
    starting = null;
  });
  return starting;
}
const links = [
  { name: "Overview", path: "/", icon: LayoutGrid },
  ...modes.map((mode) => ({ ...modeInfo[mode], icon: modeIcons[mode] })),
];
function Connections({ data }: { data: Workspace | null }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const services = [
    ["Gemini agent", "gemini_api_city_buddy", data?.configured.gemini],
    ["Maps Experience MCP", "google_map_api_city_buddy", data?.configured.maps],
    [
      "Interactive map",
      "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",
      data?.configured.browserMap,
    ],
  ] as const;
  return (
    <>
      <p className="modal-description">
        Configure the Google services in your project’s <code>.env</code>{" "}
        file. Restart the development server after changing keys.
      </p>
      <div className="connection-list">
        {services.map(([label, key, ok]) => (
          <div key={key}>
            {ok ? <CheckCircle2 size={19} /> : <CircleDashed size={19} />}
            <div>
              <strong>{label}</strong>
              <code>{key}</code>
            </div>
            <small>{ok ? "Key set" : "Key needed"}</small>
          </div>
        ))}
      </div>
      <button
        className="secondary"
        disabled={checking}
        onClick={async () => {
          setChecking(true);
          setError("");
          setResult("");
          try {
            const health = await api<{ tools: string[] }>("mcp/health");
            setResult("Connected. Available tools: " + health.tools.join(", "));
          } catch (e) {
            setError(errorText(e));
          } finally {
            setChecking(false);
          }
        }}
      >
        {checking ? <Spinner /> : <PlugZap size={16} />} Test MCP connection
      </button>
      {error && <ErrorNote>{error}</ErrorNote>}
      {result && (
        <p className="form-note" role="status">
          {result}
        </p>
      )}
    </>
  );
}
export function AppFrame({ children }: { children: ReactNode }) {
  const path = usePathname();
  const isModule = modes.some((mode) => modeInfo[mode].path === path);
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"location" | "connections" | null>(null);
  const [menu, setMenu] = useState(false);
  const refresh = useCallback(async () => {
    const w = await api<Workspace>("workspace");
    setData(w);
    setError("");
  }, []);
  useEffect(() => {
    void bootstrap()
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    setMenu(false);
  }, [path]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);
  const title =
    links.find((l) => l.path === path)?.name ??
    (path === "/history" ? "Session history" : "Workspace");
  const changeLocation = () => setPanel("location");
  const connections = () => setPanel("connections");
  const startupError = error && (
    <ErrorNote>
      {error}{" "}
      <button
        className="text-button"
        onClick={() => void refresh().catch((e) => setError(errorText(e)))}
      >
        Retry
      </button>
    </ErrorNote>
  );
  return (
    <WorkspaceContext.Provider
      value={{ data, refresh, changeLocation, connections }}
    >
      <a className="skip" href="#main">
        Skip to content
      </a>
      {isModule ? (
        <main id="main" className="module-main">
          {startupError && <div className="module-error">{startupError}</div>}
          {children}
        </main>
      ) : (
        <div className="shell">
          {menu && (
            <button
              className="nav-backdrop"
              aria-label="Close navigation"
              onClick={() => setMenu(false)}
            />
          )}
          <aside
            className={"sidebar" + (menu ? " open" : "")}
            aria-label="Workspace sidebar"
          >
            <div className="brand-line">
              <Link className="brand" href="/" aria-label="CityBuddy home">
                <img width="36" height="36" src="/icon.svg" alt="" />
                CityBuddy
              </Link>
              <button
                className="mobile-close icon-button"
                onClick={() => setMenu(false)}
                aria-label="Close navigation"
              >
                <X size={18} />
              </button>
            </div>
            <div className="nav-label">Workspace</div>
            <nav className="nav-list" aria-label="Main navigation">
              {links.map(({ name, path: target, icon: Icon }) => (
                <Link
                  key={target}
                  href={target}
                  aria-current={path === target ? "page" : undefined}
                  className={path === target ? "selected" : ""}
                >
                  <Icon size={19} />
                  {name}
                </Link>
              ))}
            </nav>
            <div className="nav-rule" />
            <Link
              href="/history"
              className={
                "history-nav" + (path === "/history" ? " selected" : "")
              }
              aria-current={path === "/history" ? "page" : undefined}
            >
              <History size={19} />
              Session history
            </Link>
            <div className="sidebar-end">
              <button
                onClick={() => {
                  setMenu(false);
                  connections();
                }}
              >
                <Cable size={18} />
                Connections
              </button>
              <div>
                <Compass size={15} />
                Personal workspace
              </div>
            </div>
          </aside>
          <div className="main-col">
            <header className="topbar">
              <button
                className="menu-button icon-button"
                onClick={() => setMenu(true)}
                aria-label="Open navigation"
                aria-expanded={menu}
              >
                <Menu size={22} />
              </button>
              <div className="breadcrumb">
                <Compass size={17} />
                <span>Workspace</span>
                <ChevronRight size={14} />
                <strong>{title}</strong>
              </div>
              <Link className="mobile-brand" href="/">
                <img src="/icon.svg" alt="" width="27" height="27" />
                CityBuddy
              </Link>
              <button
                className="active-location"
                onClick={changeLocation}
                title={data?.location ? "Change Location" : "Set your location"}
              >
                <MapPin size={15} />
                <span>{data?.location?.name ?? "No location set"}</span>
                <ChevronDown size={14} />
              </button>
            </header>
            <main id="main" className="main-content">
              {startupError}
              {children}
            </main>
          </div>
        </div>
      )}
      {panel && (
        <Modal
          title={
            panel === "location"
              ? data?.location
                ? "Change Location"
                : "Where are you exploring today?"
              : "Connections"
          }
          close={() => setPanel(null)}
        >
          {panel === "location" ? (
            <LocationForm compact onSelect={() => setPanel(null)} />
          ) : (
            <Connections data={data} />
          )}
        </Modal>
      )}
    </WorkspaceContext.Provider>
  );
}
