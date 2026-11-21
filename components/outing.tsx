"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CalendarDays, MapPin, RefreshCw, Search } from "lucide-react";
import { api, errorText } from "@/lib/client/api";
import type { Location, Place } from "@/lib/contracts";
import {
  categories,
  defaults,
  modesOfTravel,
  type Category,
  type JobStatus,
  type Nearby,
  type Preferences,
  type Prepared,
  type ReplanInput,
  type TripView,
} from "@/lib/outing-contracts";
import { Sources } from "./location-form";
import { MapPanel } from "./map-panel";
import { ErrorNote, Spinner } from "./ui";
import { useWorkspace } from "./workspace";

type Panel = {
  preferences: Preferences;
  trip: TripView | null;
  prepared: Prepared | null;
  job: { id: string; status: JobStatus; error?: string } | null;
  simulator: boolean;
};
const waiting = ["created", "queued", "running", "waiting"];
const travelLabels = {
  walking: "Walking",
  cycling: "Cycling",
  driving: "Driving",
};
const categoryLabels: Record<Category, string> = {
  attraction: "Attractions",
  museum: "Museums",
  park: "Parks",
  meal: "Restaurants",
  cafe: "Cafés",
  electronics: "Electronics",
  footwear: "Footwear",
  grocery: "Groceries",
  household: "Household",
  market: "Markets",
};
const minute = (time: string) =>
  Number(time.split(":")[0]) * 60 + Number(time.split(":")[1]);
const clock = (n: number) =>
  String(Math.floor(n / 60)).padStart(2, "0") +
  ":" +
  String(n % 60).padStart(2, "0");

export function OutingPage() {
  const { data, refresh, changeLocation } = useWorkspace();
  const [state, setState] = useState<Panel>();
  const [draft, setDraft] = useState<Preferences>(defaults);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("12:00");
  const [meal, setMeal] = useState("none");
  const [mealPreference, setMealPreference] = useState("");
  const [budget, setBudget] = useState("");
  const [shop, setShop] = useState(true);
  const [query, setQuery] = useState("");
  const [nearby, setNearby] = useState<Nearby>();
  const [selections, setSelections] = useState<
    Record<string, "required" | "optional">
  >({});
  const [selected, setSelected] = useState<string | null>(null);
  const [mapMove, setMapMove] = useState(false);
  const [coords, setCoords] = useState("");
  const [remaining, setRemaining] = useState("60");
  const [radius, setRadius] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const next = await api<Panel>("outing");
    setState(next);
    return next;
  }, []);
  const userId = data?.user_id;
  useEffect(() => {
    if (!userId) return;
    void load()
      .then((next) => setDraft(next.preferences))
      .catch((e) => setError(errorText(e)));
  }, [load, userId]);
  const placeId = data?.location?.place_id;
  useEffect(() => {
    if (!userId) return;
    setNearby(undefined);
    setSelected(null);
    void load().catch((e) => setError(errorText(e)));
  }, [load, placeId, userId]);
  const jobStatus = state?.job?.status;
  useEffect(() => {
    if (!jobStatus || !waiting.includes(jobStatus)) return;
    const timer = window.setInterval(() => void load().catch(() => {}), 1800);
    return () => window.clearInterval(timer);
  }, [jobStatus, load]);

  const act = async (label: string, action: () => Promise<void>) => {
    setError("");
    setNotice("");
    setBusy(label);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  async function search(explore = false) {
    await act("Searching the local catalog", async () => {
      const params = new URLSearchParams({
        q: query,
        explore: explore ? "1" : "0",
      });
      if (radius) params.set("radius", radius);
      const result = await api<Nearby>("places/nearby?" + params);
      setNearby(result);
      if (result.places.length)
        void api("recommendations", "POST", {
          action: "shown",
          placeIds: result.places.map((p) => p.place_id),
        }).catch(() => {});
    });
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    await act("Building the itinerary", async () => {
      await api("trips/plan", "POST", {
        requestId: crypto.randomUUID(),
        constraints: {
          ...draft,
          startMinute: minute(start),
          endMinute: minute(end),
          meal,
          mealPreference,
          ...(budget ? { budgetINR: Number(budget) } : {}),
          includeShopping: shop,
          mandatoryIds: Object.keys(selections).filter(
            (id) => selections[id] === "required",
          ),
          optionalIds: Object.keys(selections).filter(
            (id) => selections[id] === "optional",
          ),
        },
      });
      await load();
    });
  }
  function replan(action: ReplanInput["action"], stopId?: string) {
    if (!state?.trip) return;
    const trip = state.trip;
    return act("Updating the itinerary", async () => {
      try {
        await api("trips/" + trip.id + "/replan", "POST", {
          version: trip.version,
          action,
          stopId,
          ...(action === "shorten"
            ? { remainingMinutes: Number(remaining) }
            : {}),
        });
      } finally {
        await load();
      }
    });
  }
  function move(point: { latitude: number; longitude: number }) {
    return act("Updating the simulated location", async () => {
      await api("location/simulate", "POST", point);
      setMapMove(false);
      setNearby(undefined);
      await refresh();
      await load();
    });
  }
  const trip = state?.trip;
  const found = nearby?.places ?? state?.prepared?.recommendations ?? [];
  const mapPlaces: Place[] = [
    ...new Map(
      [
        ...found,
        ...(trip?.stops.flatMap((s) =>
          s.place && s.status === "pending" ? [s.place] : [],
        ) ?? []),
      ].map((p) => [p.place_id, p]),
    ).values(),
  ];

  return (
    <div className="inner-page outing-page">
      <div className="page-title">
        <span className="page-icon live_talk">
          <CalendarDays />
        </span>
        <div>
          <h1>Outing planner</h1>
          <p>Find nearby places and build a plan around your time.</p>
        </div>
      </div>
      <div className="outing-actions">
        <button className="secondary" onClick={changeLocation}>
          <MapPin size={16} />
          {data?.location?.name ?? "Set location"}
        </button>
        {busy && (
          <span className="working" role="status">
            <Spinner />
            {busy}
          </span>
        )}
        {notice && <span role="status">{notice}</span>}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="outing-grid">
        <div className="outing-column">
          <section
            className="panel outing-card"
            aria-labelledby="outing-settings"
          >
            <h2 id="outing-settings">Plan an outing</h2>
            <form className="outing-form" onSubmit={create}>
              <div className="outing-fields">
                <label>
                  Start
                  <input
                    type="time"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    required
                  />
                </label>
                <label>
                  End
                  <input
                    type="time"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Travel mode
                  <select
                    value={draft.mode}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        mode: e.target.value as Preferences["mode"],
                      })
                    }
                  >
                    {modesOfTravel.map((mode) => (
                      <option key={mode} value={mode}>
                        {travelLabels[mode]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Maximum travel (m)
                  <input
                    type="number"
                    min={250}
                    max={30000}
                    required
                    value={draft.maxDistanceMeters}
                    onChange={(e) =>
                      setDraft({ ...draft, maxDistanceMeters: +e.target.value })
                    }
                  />
                </label>
                <label>
                  Available minutes
                  <input
                    type="number"
                    min={10}
                    max={840}
                    required
                    value={draft.availableMinutes}
                    onChange={(e) =>
                      setDraft({ ...draft, availableMinutes: +e.target.value })
                    }
                  />
                </label>
                <label>
                  Budget in ₹
                  <input
                    type="number"
                    min={0}
                    max={1000000}
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                    placeholder="Optional"
                  />
                </label>
                <label>
                  Meal
                  <select
                    value={meal}
                    onChange={(e) => setMeal(e.target.value)}
                  >
                    <option value="none">No meal</option>
                    <option value="breakfast">Breakfast</option>
                    <option value="lunch">Lunch</option>
                    <option value="dinner">Dinner</option>
                  </select>
                </label>
                {meal !== "none" && (
                  <label>
                    Meal preference
                    <input
                      value={mealPreference}
                      maxLength={80}
                      onChange={(e) => setMealPreference(e.target.value)}
                      placeholder="e.g. vegetarian"
                    />
                  </label>
                )}
              </div>
              <fieldset className="outing-interests">
                <legend>Interests</legend>
                {categories.map((category) => (
                  <label key={category}>
                    <input
                      type="checkbox"
                      checked={draft.interests.includes(category)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          interests: e.target.checked
                            ? [...draft.interests, category]
                            : draft.interests.filter((c) => c !== category),
                        })
                      }
                    />
                    {categoryLabels[category]}
                  </label>
                ))}
              </fieldset>
              <label className="outing-check">
                <input
                  type="checkbox"
                  checked={shop}
                  onChange={(e) => setShop(e.target.checked)}
                />
                Include pending shopping
              </label>
              {!!Object.keys(selections).length && (
                <p>{Object.keys(selections).length} nearby place selections</p>
              )}
              <div className="outing-actions">
                <button
                  className="primary"
                  disabled={!data?.location || !!busy}
                >
                  Build itinerary
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!!busy || !state}
                  onClick={() =>
                    void act("Saving preferences", async () => {
                      await api("preferences", "PATCH", draft);
                      await load();
                      setNotice("Preferences saved.");
                    })
                  }
                >
                  Save preferences
                </button>
              </div>
            </form>
          </section>
          <section
            className="panel outing-card"
            aria-labelledby="active-itinerary"
          >
            <h2 id="active-itinerary">Active itinerary</h2>
            {!trip ? (
              <p className="outing-muted">
                Build an itinerary to see your stops here.
              </p>
            ) : (
              <>
                <p className="outing-muted">
                  Version {trip.version} · {travelLabels[trip.constraints.mode]}{" "}
                  · travel estimates use straight-line distances
                </p>
                {!trip.feasible && (
                  <p className="outing-note">
                    The available stops don’t satisfy every planning constraint.
                  </p>
                )}
                <ol className="outing-stops">
                  {trip.stops.map((stop) => (
                    <li key={stop.id} data-status={stop.status}>
                      <div className="outing-stop-line">
                        <time>{clock(stop.arrivalMinute)}</time>
                        {stop.place && stop.status === "pending" ? (
                          <button
                            className="text-button"
                            type="button"
                            onClick={() => setSelected(stop.place!.place_id)}
                          >
                            {stop.label}
                          </button>
                        ) : (
                          <strong>{stop.label}</strong>
                        )}
                        <span>{stop.status}</span>
                      </div>
                      <p className="outing-muted">
                        {stop.visitMinutes} min visit
                        {stop.travelMinutes > 0 &&
                          " · ~" + stop.travelMinutes + " min travel"}
                        {stop.mandatory && " · Required"}
                      </p>
                      {stop.status === "pending" && (
                        <div className="outing-actions">
                          <button
                            className="text-button"
                            disabled={!!busy}
                            onClick={() => void replan("visit_stop", stop.id)}
                          >
                            Mark visited
                          </button>
                          <button
                            className="text-button"
                            disabled={!!busy}
                            onClick={() => void replan("skip_stop", stop.id)}
                          >
                            Skip
                          </button>
                          {state?.simulator && stop.place && (
                            <button
                              className="text-button"
                              disabled={!!busy}
                              onClick={() =>
                                void act("Simulating arrival", async () => {
                                  await api("location/simulate", "POST", {
                                    tripId: trip.id,
                                    stopId: stop.id,
                                  });
                                  await refresh();
                                  await load();
                                })
                              }
                            >
                              Simulate arrival
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
                {trip.notes.map((note) => (
                  <p key={note} className="outing-note">
                    {note}
                  </p>
                ))}
                <div className="outing-actions">
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() => void replan("lunch_first")}
                  >
                    Lunch first
                  </button>
                  <button
                    className="secondary"
                    disabled={!!busy || !trip.constraints.includeShopping}
                    onClick={() => void replan("remove_shopping")}
                  >
                    Remove shopping
                  </button>
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() => void replan("refresh")}
                  >
                    <RefreshCw size={14} />
                    Replan
                  </button>
                </div>
                <form
                  className="outing-actions outing-short"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void replan("shorten");
                  }}
                >
                  <label>
                    Minutes left
                    <input
                      type="number"
                      min={10}
                      max={840}
                      required
                      value={remaining}
                      onChange={(e) => setRemaining(e.target.value)}
                    />
                  </label>
                  <button className="secondary" disabled={!!busy}>
                    Update time
                  </button>
                </form>
              </>
            )}
          </section>
        </div>
        <div className="outing-column">
          <div className="outing-map panel">
            <MapPanel
              location={data?.location ?? null}
              places={mapPlaces}
              routes={[]}
              selected={selected}
              choose={setSelected}
              clearSelection={() => setSelected(null)}
              changeLocation={changeLocation}
              bottomInset={0}
              onSimulate={mapMove && !busy ? (p) => void move(p) : undefined}
            />
          </div>
          <section className="panel outing-card">
            <h2>Nearby places</h2>
            {!nearby && state?.prepared?.recommendationAnchor && (
              <p className="outing-muted">
                Prepared near {state.prepared.recommendationAnchor}
              </p>
            )}
            <form
              className="outing-actions"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <input
                aria-label="Search nearby"
                value={query}
                maxLength={160}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Attractions, groceries, cafés…"
              />
              <button className="primary" disabled={!data?.location || !!busy}>
                <Search size={15} />
                Search
              </button>
              <button
                className="secondary"
                type="button"
                disabled={!data?.location || !!busy}
                onClick={() => void search(true)}
              >
                Explore
              </button>
            </form>
            {nearby && (
              <p className="outing-muted">
                {nearby.candidateCount} candidates within {nearby.radius} m ·{" "}
                {nearby.radii.length > 1 ? "Radius expanded" : "Local catalog"}
              </p>
            )}
            {nearby && !found.length && (
              <p>No matching places in the local catalog at this location.</p>
            )}
            <ul className="outing-results">
              {found.map((p) => (
                <li key={p.place_id}>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setSelected(p.place_id)}
                  >
                    {p.name}
                  </button>
                  <p className="outing-muted">
                    {categoryLabels[p.category]} · {p.distanceMeters} m
                    straight-line · ~{p.travelMinutes} min travel
                  </p>
                  <p>{p.reason}</p>
                  <Sources values={p.sources} />
                  <div className="outing-actions">
                    {(["required", "optional"] as const).map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        className="text-button"
                        aria-pressed={selections[p.place_id] === choice}
                        onClick={() =>
                          setSelections((current) => {
                            const next = { ...current };
                            if (next[p.place_id] === choice)
                              delete next[p.place_id];
                            else next[p.place_id] = choice;
                            return next;
                          })
                        }
                      >
                        {selections[p.place_id] === choice ? "✓ " : ""}
                        {choice === "required"
                          ? "Required stop"
                          : "Optional stop"}
                      </button>
                    ))}
                    <button
                      className="text-button"
                      type="button"
                      disabled={!!busy}
                      onClick={() =>
                        void act("Updating recommendations", async () => {
                          await api("recommendations", "POST", {
                            placeId: p.place_id,
                            action: "dismissed",
                          });
                          setNearby(
                            (current) =>
                              current && {
                                ...current,
                                places: current.places.filter(
                                  (place) => place.place_id !== p.place_id,
                                ),
                              },
                          );
                          await load();
                        })
                      }
                    >
                      Dismiss
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          {state?.prepared?.suggestion && (
            <section className="panel outing-card">
              <h2>Suggested next</h2>
              <p>{state.prepared.suggestion}</p>
              {state.prepared.overview && <p>{state.prepared.overview}</p>}
            </section>
          )}
          {state?.simulator && (
            <section className="panel outing-card">
              <h2>Location simulator</h2>
              <form
                className="outing-actions"
                onSubmit={(e) => {
                  e.preventDefault();
                  const pair = coords.split(",").map((part) => part.trim());
                  if (
                    pair.length !== 2 ||
                    pair.some((x) => !x || !Number.isFinite(Number(x)))
                  ) {
                    setError(
                      "Enter latitude and longitude separated by a comma.",
                    );
                    return;
                  }
                  void move({
                    latitude: Number(pair[0]),
                    longitude: Number(pair[1]),
                  });
                }}
              >
                <input
                  value={coords}
                  onChange={(e) => setCoords(e.target.value)}
                  aria-label="Simulated latitude and longitude"
                  placeholder="26.9239, 75.8267"
                  required
                />
                <button className="secondary" disabled={!!busy}>
                  Move
                </button>
              </form>
              <div className="outing-actions">
                <button
                  className="secondary"
                  disabled={!data?.location || !!busy}
                  aria-pressed={mapMove}
                  onClick={() => setMapMove(!mapMove)}
                >
                  {mapMove ? "Cancel map selection" : "Pick on map"}
                </button>
                <button
                  className="secondary"
                  disabled={!data?.location || !!busy}
                  onClick={() =>
                    void act("Queueing preparation", async () => {
                      await api("outing", "POST");
                      await load();
                    })
                  }
                >
                  Prepare context
                </button>
                <button
                  className="text-button"
                  disabled={!data?.location || !!busy}
                  onClick={() =>
                    void act("Clearing location", async () => {
                      await api<{ location: Location | null }>(
                        "location",
                        "PATCH",
                        { clear: true },
                      );
                      await refresh();
                      await load();
                    })
                  }
                >
                  Clear location
                </button>
              </div>
              {mapMove && (
                <p>
                  Click the offline map above to set your simulated coordinates.
                </p>
              )}
              <label className="outing-check">
                Search radius override (m)
                <input
                  type="number"
                  min={100}
                  max={30000}
                  value={radius}
                  onChange={(e) => setRadius(e.target.value)}
                  placeholder="Adaptive"
                />
              </label>
              <dl className="outing-diagnostics">
                <div>
                  <dt>Location</dt>
                  <dd>{data?.location?.name ?? "Unset"}</dd>
                </div>
                <div>
                  <dt>Travel mode</dt>
                  <dd>{travelLabels[state.preferences.mode]}</dd>
                </div>
                <div>
                  <dt>Available time</dt>
                  <dd>{state.preferences.availableMinutes} min</dd>
                </div>
                <div>
                  <dt>Search radius</dt>
                  <dd>{nearby?.radius ?? state.prepared?.radius ?? "—"} m</dd>
                </div>
                <div>
                  <dt>Candidates</dt>
                  <dd>
                    {nearby?.candidateCount ??
                      state.prepared?.candidateCount ??
                      "—"}
                  </dd>
                </div>
                <div>
                  <dt>Active trip</dt>
                  <dd>{trip ? "Version " + trip.version : "None"}</dd>
                </div>
                <div>
                  <dt>Pending shopping</dt>
                  <dd>
                    {data?.items.filter((i) => i.status === "pending").length ??
                      0}
                  </dd>
                </div>
                <div>
                  <dt>Prefetch status</dt>
                  <dd>
                    {state.job?.status ?? (state.prepared ? "ready" : "idle")}
                  </dd>
                </div>
              </dl>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
