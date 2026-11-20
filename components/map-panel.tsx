"use client";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Map, MapPin, Milestone } from "lucide-react";
import { type Location, type Place, type RouteResult } from "@/lib/contracts";
import { Sources } from "./location-form";
import { Spinner } from "./ui";

declare global {
  interface Window {
    cityBuddyMapsReady?: () => void;
    gm_authFailure?: () => void;
  }
}
let mapLoading: Promise<void> | null = null;
function loadMap() {
  if (typeof google !== "undefined" && google.maps?.marker)
    return Promise.resolve();
  if (mapLoading) return mapLoading;
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  mapLoading = new Promise<void>((resolve, reject) => {
    const tag = document.createElement("script");
    const fail = () => {
      window.clearTimeout(timer);
      mapLoading = null;
      tag.remove();
      reject(
        new Error(
          "Google Maps could not load. Check the browser key and its website restrictions.",
        ),
      );
    };
    const timer = window.setTimeout(fail, 14000);
    window.cityBuddyMapsReady = () => {
      window.clearTimeout(timer);
      resolve();
    };
    window.gm_authFailure = () => {
      window.dispatchEvent(new Event("citybuddy-map-auth-error"));
      fail();
    };
    tag.async = true;
    tag.onerror = fail;
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
export function GoogleMap({
  location,
  places,
  routes,
  selected,
  choose,
}: {
  location: Location;
  places: Place[];
  routes: RouteResult[];
  selected: string | null;
  choose: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const ref = useRef<google.maps.Map | null>(null);
  const pick = useRef(choose);
  pick.current = choose;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const fail = () => {
      if (alive)
        setError(
          "Google Maps rejected the browser key. Check Maps JavaScript API and the allowed website in your Google Cloud project.",
        );
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
          fullscreenControl: true,
        });
        setReady(true);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      ref.current = null;
      window.removeEventListener("citybuddy-map-auth-error", fail);
    };
  }, [location.latitude, location.longitude]);
  useEffect(() => {
    const map = ref.current;
    if (!ready || !map) return;
    const bounds = new google.maps.LatLngBounds();
    const center = { lat: location.latitude, lng: location.longitude };
    bounds.extend(center);
    const entries = [
      ...new globalThis.Map(
        [location, ...places].map((p) => [p.place_id, p]),
      ).values(),
    ];
    const markers = entries.flatMap((p) => {
      if (p.latitude === null || p.longitude === null) return [];
      const position = { lat: p.latitude, lng: p.longitude };
      bounds.extend(position);
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position,
        title: p.name,
        gmpClickable: true,
      });
      const listener = marker.addListener("click", () => {
        pick.current(p.place_id);
      });
      return [{ marker, listener }];
    });
    const paths = routes.flatMap((r) => {
      if (!r.encoded_polyline) return [];
      const path = google.maps.geometry.encoding.decodePath(r.encoded_polyline);
      path.forEach((p) => bounds.extend(p));
      return [
        new google.maps.Polyline({
          map,
          path,
          strokeColor: "#276351",
          strokeWeight: 5,
        }),
      ];
    });
    if (markers.length > 1 || paths.length) map.fitBounds(bounds, 36);
    else {
      map.setCenter(center);
      map.setZoom(14);
    }
    return () => {
      for (const { marker, listener } of markers) {
        listener.remove();
        marker.map = null;
      }
      for (const line of paths) line.setMap(null);
    };
  }, [location, places, routes, ready]);
  useEffect(() => {
    const p = [location, ...places].find((p) => p.place_id === selected);
    if (p && p.latitude !== null && p.longitude !== null && ref.current) {
      ref.current.panTo({ lat: p.latitude, lng: p.longitude });
      ref.current.setZoom(16);
    }
  }, [selected, location, places, ready]);
  return (
    <div className="map-wrap">
      <div
        className="map-canvas"
        ref={container}
        aria-label="Google map of selected location and returned places"
      />
      {(error || !ready) && (
        <div className="map-cover">
          {error || (
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
}: {
  location: Location | null;
  places: Place[];
  routes: RouteResult[];
  selected: string | null;
  choose: (id: string) => void;
}) {
  const shown =
    places.some((p) => p.place_id === selected) ||
    !location ||
    location.place_id !== selected
      ? places
      : [location, ...places];
  return (
    <section className="panel map-panel">
      <h2>
        <Map size={19} />
        Area map
      </h2>
      {process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY && location ? (
        <GoogleMap
          key={location.place_id}
          location={location}
          places={places}
          routes={routes}
          selected={selected}
          choose={choose}
        />
      ) : (
        <div className="map-placeholder">
          <span>
            <Map size={30} />
          </span>
          <strong>
            {!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
              ? "Interactive map unavailable"
              : "Choose a starting point"}
          </strong>
          <p>
            {!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
              ? "Add the Maps JavaScript browser key to enable the map. Place results appear below."
              : "Set a location to see it on the map."}
          </p>
        </div>
      )}
      <div className="nearby">
        <h3>
          <MapPin size={16} />
          Places
        </h3>
        {shown.length ? (
          <ol>
            {shown.map((p) => (
              <li
                key={p.place_id}
                className={selected === p.place_id ? "focused" : ""}
                id={"place-" + p.place_id}
              >
                <button
                  onClick={() => choose(p.place_id)}
                  aria-pressed={selected === p.place_id}
                >
                  <strong>{p.name}</strong>
                  {p.formatted_address && <small>{p.formatted_address}</small>}
                </button>
                {p.summary && <p>{p.summary}</p>}
                {p.maps_url && (
                  <a href={p.maps_url} target="_blank" rel="noreferrer">
                    Open in Google Maps <ExternalLink size={12} />
                  </a>
                )}
                <Sources values={p.sources} />
              </li>
            ))}
          </ol>
        ) : (
          <p>Places from your conversation will appear here.</p>
        )}
      </div>
      {routes.map((route, i) => (
        <RouteCard route={route} key={i} />
      ))}
    </section>
  );
}
