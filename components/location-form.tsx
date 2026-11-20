"use client";
import { useId, useState, type FormEvent } from "react";
import { Check, ExternalLink, LocateFixed, MapPin, Search } from "lucide-react";
import type { Location, Source } from "@/lib/contracts";
import { api, errorText } from "@/lib/client/api";
import { useWorkspace } from "./workspace";
import { ErrorNote, Spinner } from "./ui";

export function Sources({ values }: { values: Source[] }) {
  if (!values.length) return null;
  return (
    <div className="sources">
      <strong>Google Maps</strong>
      {values.map((s) => (
        <a key={s.title + s.url} href={s.url} target="_blank" rel="noreferrer">
          {s.title}
          <ExternalLink size={11} aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}
export function LocationForm({
  onSelect,
  compact = false,
}: {
  onSelect?: () => void;
  compact?: boolean;
}) {
  const { data, refresh } = useWorkspace();
  const id = useId();
  const [query, setQuery] = useState("");
  const [choices, setChoices] = useState<Location[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  async function select(place: Location) {
    await api("location/select", "POST", { place_id: place.place_id });
    await refresh();
    setChoices([]);
    setQuery("");
    setNote("Location set to " + place.name + ".");
    onSelect?.();
  }
  async function find(text: string) {
    if (!text.trim() || busy || !data) return;
    setBusy(true);
    setError("");
    setNote("");
    setChoices([]);
    try {
      const { choices: found } = await api<{ choices: Location[] }>(
        "location/resolve",
        "POST",
        { query: text.trim() },
      );
      if (found.length === 1) await select(found[0]);
      else if (found.length) {
        setChoices(found);
        setNote("Choose the location you meant.");
      } else
        setNote(
          "No matching location with map coordinates was found. Try adding a city or locality.",
        );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void find(query);
  }
  return (
    <section
      className={
        compact ? "location-form" : "panel location-panel location-form"
      }
      aria-label="Manual location selection"
    >
      {!compact && (
        <div className="location-heading">
          <span className="location-symbol">
            <MapPin size={22} />
          </span>
          <h2>Where are you exploring today?</h2>
        </div>
      )}
      {compact && (
        <p className="modal-description">
          {data?.location
            ? "Your current location is " + data.location.name + ". "
            : ""}
          Choose a starting point for nearby searches and directions.
        </p>
      )}
      <form className="location-fields" onSubmit={submit}>
        <label htmlFor={id} className="sr-only">
          City, locality, address, or landmark
        </label>
        <div className="search-box">
          <Search size={18} aria-hidden="true" />
          <input
            id={id}
            autoComplete="off"
            autoFocus={compact}
            type="text"
            placeholder="Enter city, locality, address, or landmark..."
            value={query}
            maxLength={1200}
            required
            minLength={2}
            onChange={(e) => {
              setQuery(e.target.value);
              setChoices([]);
              setNote("");
              setError("");
            }}
          />
        </div>
        <button className="primary" type="submit" disabled={busy || !data}>
          {busy ? <Spinner /> : <LocateFixed size={17} />} Set Location
        </button>
      </form>
      <div className="suggestions">
        <span>Try</span>
        {["Jaipur", "Mansarovar, Jaipur", "Hawa Mahal, Jaipur"].map((ex) => (
          <button
            key={ex}
            disabled={busy || !data}
            type="button"
            onClick={() => {
              setQuery(ex);
              void find(ex);
            }}
          >
            {ex}
          </button>
        ))}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {note && (
        <p className="form-note" role="status">
          {note}
        </p>
      )}
      {!!choices.length && (
        <ul className="location-choices">
          {choices.map((p) => (
            <li key={p.place_id}>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await select(p);
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <MapPin size={17} />
                <span>
                  <strong>{p.name}</strong>
                  {p.formatted_address && <small>{p.formatted_address}</small>}
                </span>
                <Check size={16} />
              </button>
              <Sources values={p.sources} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
