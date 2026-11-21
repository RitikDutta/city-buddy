"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ExternalLink, MapPin, Milestone, X } from "lucide-react";
import { type Location, type Place, type RouteResult } from "@/lib/contracts";
import { Spinner } from "./ui";

declare global {
  interface Window {
    cityBuddyMapsReady?: () => void;
    gm_authFailure?: () => void;
  }
}
let mapLoading: Promise<void> | null = null;
let mapAuthFailed = false;
const mapLoadError =
  "Google Maps could not load. Check your connection and try again.";
const mapAuthError =
  "Google Maps rejected the browser key. Check Maps JavaScript API and the allowed website in your Google Cloud project.";

function loadMap() {
  if (mapAuthFailed) return Promise.reject(new Error(mapAuthError));
  if (
    typeof google !== "undefined" &&
    google.maps?.marker &&
    google.maps.geometry
  )
    return Promise.resolve();
  if (mapLoading) return mapLoading;
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  mapLoading = new Promise<void>((resolve, reject) => {
    const tag = document.createElement("script");
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      mapLoading = null;
      tag.remove();
      reject(new Error(message));
    };
    const timer = window.setTimeout(() => fail(mapLoadError), 24_000);
    window.cityBuddyMapsReady = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    window.gm_authFailure = () => {
      mapAuthFailed = true;
      window.dispatchEvent(new Event("citybuddy-map-auth-error"));
      fail(mapAuthError);
    };
    tag.async = true;
    tag.onerror = () => fail(mapLoadError);
    tag.src =
      "https://maps.googleapis.com/maps/api/js?" +
      new URLSearchParams({
        key: key ?? "",
        v: "weekly",
        loading: "async",
        libraries: "marker,geometry",
        callback: "cityBuddyMapsReady",
      });
    document.head.appendChild(tag);
  });
  return mapLoading;
}
function GoogleMap({
  location,
  places,
  routes,
  selected,
  choose,
  bottomInset,
}: {
  location: Location;
  places: Place[];
  routes: RouteResult[];
  selected: string | null;
  choose: (id: string) => void;
  bottomInset: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const ref = useRef<google.maps.Map | null>(null);
  const pick = useRef(choose);
  pick.current = choose;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const fail = () => {
      if (alive) setError(mapAuthError);
    };
    window.addEventListener("citybuddy-map-auth-error", fail);
    void loadMap()
      .then(() => {
        if (!alive || !container.current) return;
        ref.current = new google.maps.Map(container.current, {
          center: { lat: location.latitude, lng: location.longitude },
          zoom: 14,
          mapId: process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || "DEMO_MAP_ID",
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
          gestureHandling: "greedy",
          cameraControl: false,
          zoomControl: true,
          zoomControlOptions: {
            position: google.maps.ControlPosition.TOP_RIGHT,
          },
        });
        setReady(true);
      })
      .catch((e) => {
        if (alive)
          setError(e.message === mapAuthError ? mapAuthError : mapLoadError);
      });
    return () => {
      alive = false;
      ref.current = null;
      window.removeEventListener("citybuddy-map-auth-error", fail);
    };
  }, [location.latitude, location.longitude, attempt]);
  const geometry = useMemo(() => {
    if (!ready) return;
    const bounds = new google.maps.LatLngBounds();
    const pins = [
      ...new globalThis.Map(
        [...places, location].map((p) => [p.place_id, p]),
      ).values(),
    ].flatMap((p) => {
      if (p.latitude === null || p.longitude === null) return [];
      const position = { lat: p.latitude, lng: p.longitude };
      bounds.extend(position);
      return [{ place: p, position }];
    });
    const paths = routes.flatMap((r) => {
      if (!r.encoded_polyline) return [];
      const path = google.maps.geometry.encoding.decodePath(r.encoded_polyline);
      path.forEach((p) => bounds.extend(p));
      return [path];
    });
    return { pins, paths, bounds };
  }, [location, places, routes, ready]);
  useEffect(() => {
    const map = ref.current;
    if (!map || !geometry) return;
    const markers = geometry.pins.map(({ place, position }) => {
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position,
        title: place.name,
        gmpClickable: true,
      });
      const select = () => pick.current(place.place_id);
      marker.addEventListener("gmp-click", select);
      return { marker, select };
    });
    const lines = geometry.paths.map(
      (path) =>
        new google.maps.Polyline({
          map,
          path,
          strokeColor: "#276351",
          strokeWeight: 5,
        }),
    );
    return () => {
      for (const { marker, select } of markers) {
        marker.removeEventListener("gmp-click", select);
        marker.map = null;
      }
      for (const line of lines) line.setMap(null);
    };
  }, [geometry]);
  useEffect(() => {
    const map = ref.current;
    if (!map || !geometry) return;
    // Keep destinations in the visible viewport above the conversation.
    const height = map.getDiv().clientHeight;
    const bottom = Math.min(bottomInset + 26, height * 0.76);
    const top = Math.min(62, height * 0.18);
    const focus = geometry.pins.find(
      ({ place }) => place.place_id === selected,
    );
    if (!geometry.paths.length && (focus || geometry.pins.length === 1)) {
      map.moveCamera({
        center: (focus ?? geometry.pins[0]).position,
        zoom: focus ? 16 : 14,
      });
      map.panBy(0, Math.round((bottom - top) / 2));
    } else {
      map.fitBounds(geometry.bounds, { top, bottom, left: 36, right: 52 });
    }
  }, [geometry, selected, bottomInset]);
  return (
    <div className="map-wrap">
      <div
        className="map-canvas"
        ref={container}
        aria-label="Google map of selected location and returned places"
      />
      {(error || !ready) && (
        <div className="map-cover" role={error ? "alert" : "status"}>
          {error ? (
            <div className="map-load-message">
              <p>{error}</p>
              {error === mapLoadError && (
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    setError("");
                    setReady(false);
                    setAttempt((n) => n + 1);
                  }}
                >
                  Retry map
                </button>
              )}
            </div>
          ) : (
            <>
              <Spinner />
              Loading map…
            </>
          )}
        </div>
      )}
    </div>
  );
}
export function RouteCard({ route }: { route: RouteResult }) {
  const distance =
    route.distance_meters === undefined
      ? null
      : route.distance_meters < 1000
        ? route.distance_meters + " m"
        : (route.distance_meters / 1000).toLocaleString(undefined, {
            maximumFractionDigits: 2,
          }) + " km";
  const duration =
    route.duration_seconds === undefined
      ? null
      : route.duration_seconds < 60
        ? Math.round(route.duration_seconds) + " sec"
        : Math.round(route.duration_seconds / 60) + " min";
  return (
    <div className="route-card">
      <div>
        <Milestone size={17} />
        <strong>
          {[
            route.mode === "WALK"
              ? "Walking"
              : route.mode === "DRIVE"
                ? "Driving"
                : "Route",
            distance,
            duration,
          ]
            .filter(Boolean)
            .join(" · ")}
        </strong>
      </div>
      {route.navigation_url && (
        <a href={route.navigation_url} target="_blank" rel="noreferrer">
          Open directions <ExternalLink size={13} />
        </a>
      )}
      {route.mode === "WALK" && (
        <small>
          Walking directions are in beta. Some paths may lack sidewalks or
          pedestrian access.
        </small>
      )}
    </div>
  );
}
export function MapPanel({
  location,
  places,
  routes,
  selected,
  choose,
  clearSelection,
  changeLocation,
  bottomInset,
}: {
  location: Location | null;
  places: Place[];
  routes: RouteResult[];
  selected: string | null;
  choose: (id: string) => void;
  clearSelection: () => void;
  changeLocation: () => void;
  bottomInset: number;
}) {
  const hasKey = !!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const focused =
    places.find((place) => place.place_id === selected) ??
    (location?.place_id === selected ? location : null);
  return (
    <section className="module-map" aria-label="Area map">
      {hasKey && location ? (
        <GoogleMap
          key={location.place_id}
          location={location}
          places={places}
          routes={routes}
          selected={selected}
          choose={choose}
          bottomInset={bottomInset}
        />
      ) : (
        <div className="map-placeholder">
          <p>
            {hasKey
              ? "Set a location to open the map."
              : "The map needs a Google Maps browser key."}
          </p>
        </div>
      )}
      <div className="map-tools">
        <button
          type="button"
          className="map-location"
          onClick={changeLocation}
          aria-label={
            location
              ? "Change location, currently " + location.name
              : "Set location"
          }
        >
          <MapPin size={16} />
          <span>{location?.name ?? "Set location"}</span>
          <ChevronDown size={14} />
        </button>
        {focused && (
          <div className="map-place">
            <div>
              <strong>{focused.name}</strong>
              {focused.maps_url && (
                <a href={focused.maps_url} target="_blank" rel="noreferrer">
                  Open in Google Maps <ExternalLink size={12} />
                </a>
              )}
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={clearSelection}
              aria-label="Dismiss place details"
              title="Dismiss place details"
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
