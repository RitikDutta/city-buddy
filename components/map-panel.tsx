"use client";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ExternalLink, MapPin, Milestone, X } from "lucide-react";
import { type Location, type Place, type RouteResult } from "@/lib/contracts";
import { JaipurBasemap } from "./jaipur-basemap";
import { useWorkspace } from "./workspace";

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

function loadMap(apiKey: string) {
  if (mapAuthFailed) return Promise.reject(new Error(mapAuthError));
  if (
    typeof google !== "undefined" &&
    google.maps?.marker &&
    google.maps.geometry
  )
    return Promise.resolve();
  if (mapLoading) return mapLoading;
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
        key: apiKey,
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
  apiKey,
  mapId,
  location,
  places,
  routes,
  selected,
  choose,
  bottomInset,
  fallback,
}: {
  apiKey: string;
  mapId?: string;
  location: Location;
  places: Place[];
  routes: RouteResult[];
  selected: string | null;
  choose: (id: string) => void;
  bottomInset: number;
  fallback: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const ref = useRef<google.maps.Map | null>(null);
  const pick = useRef(choose);
  pick.current = choose;
  const [ready, setReady] = useState(false);
  const [tilesReady, setTilesReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    let tiles: google.maps.MapsEventListener | undefined;
    let tileTimeout: number | undefined;
    const fail = () => {
      if (alive) setError(mapAuthError);
    };
    window.addEventListener("citybuddy-map-auth-error", fail);
    void loadMap(apiKey)
      .then(() => {
        if (!alive || !container.current) return;
        const map = new google.maps.Map(container.current, {
          center: { lat: location.latitude, lng: location.longitude },
          zoom: 14,
          mapId: mapId || "DEMO_MAP_ID",
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
        ref.current = map;
        tiles = google.maps.event.addListenerOnce(map, "tilesloaded", () => {
          window.clearTimeout(tileTimeout);
          if (alive) setTilesReady(true);
        });
        tileTimeout = window.setTimeout(() => {
          if (alive) setError((current) => current || mapLoadError);
        }, 15_000);
        setReady(true);
      })
      .catch((e) => {
        if (alive)
          setError(e.message === mapAuthError ? mapAuthError : mapLoadError);
      });
    return () => {
      alive = false;
      window.clearTimeout(tileTimeout);
      tiles?.remove();
      ref.current = null;
      window.removeEventListener("citybuddy-map-auth-error", fail);
    };
  }, [apiKey, mapId, location.latitude, location.longitude, attempt]);
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
  const visible = ready && tilesReady && !error;
  return (
    <>
      {!visible && fallback}
      <div
        className="map-wrap"
        style={{ visibility: visible ? "visible" : "hidden" }}
        aria-hidden={!visible}
      >
        <div
          className="map-canvas"
          ref={container}
          aria-label="Google map of selected location and returned places"
        />
      </div>
      {error && (
        <div
          className="map-provider-status"
          role="status"
          style={{ bottom: Math.max(38, bottomInset + 14) }}
        >
          <p>{error}</p>
          {error === mapLoadError && (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setError("");
                setReady(false);
                setTilesReady(false);
                setAttempt((n) => n + 1);
              }}
            >
              Retry Google Maps
            </button>
          )}
        </div>
      )}
    </>
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
  onSimulate,
}: {
  location: Location | null;
  places: Place[];
  routes: RouteResult[];
  selected: string | null;
  choose: (id: string) => void;
  clearSelection: () => void;
  changeLocation: () => void;
  bottomInset: number;
  onSimulate?: (point: { latitude: number; longitude: number }) => void;
}) {
  const { data } = useWorkspace();
  const browserMap = data?.browserMap;
  const preview = location ? null : data?.mapPreview;
  const center = location ?? preview?.location;
  const displayedPlaces = location ? places : (preview?.places ?? places);
  const focused =
    displayedPlaces.find((place) => place.place_id === selected) ??
    (center?.place_id === selected ? center : null);
  const localMap = center ? (
    <LocalMap
      location={center}
      places={displayedPlaces}
      selected={selected}
      choose={choose}
      bottomInset={bottomInset}
      onSimulate={location ? onSimulate : undefined}
    />
  ) : (
    <div className="map-placeholder">
      <p>Set a location to open the map.</p>
    </div>
  );
  return (
    <section className="module-map" aria-label="Area map">
      {browserMap && location && !onSimulate ? (
        <GoogleMap
          key={location.place_id}
          apiKey={browserMap.apiKey}
          mapId={browserMap.mapId}
          location={location}
          places={places}
          routes={routes}
          selected={selected}
          choose={choose}
          bottomInset={bottomInset}
          fallback={localMap}
        />
      ) : (
        localMap
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
        {preview && (
          <small className="map-preview-label">Jaipur map preview</small>
        )}
        {focused && (
          <div className="map-place">
            <div>
              <strong>{focused.name}</strong>
              {focused.maps_url && (
                <a href={focused.maps_url} target="_blank" rel="noreferrer">
                  {focused.place_id.startsWith("osm:")
                    ? "Open in OpenStreetMap"
                    : "Open map listing"}{" "}
                  <ExternalLink size={12} />
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

function LocalMap({
  location,
  places,
  selected,
  choose,
  bottomInset,
  onSimulate,
}: {
  location: Location;
  places: Place[];
  selected: string | null;
  choose: (id: string) => void;
  bottomInset: number;
  onSimulate?: (point: { latitude: number; longitude: number }) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 300, height: 200 });
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const orientation = Math.max(
    0.02,
    Math.cos((location.latitude * Math.PI) / 180),
  );
  const points = [
    ...new Map([location, ...places].map((p) => [p.place_id, p])).values(),
  ].filter((p) => p.latitude !== null && p.longitude !== null);
  const rangeX =
    Math.max(
      0.009,
      ...points.map(
        (p) => Math.abs(p.longitude! - location.longitude) * orientation,
      ),
    ) * 2.25;
  const rangeY =
    Math.max(
      0.009,
      ...points.map((p) => Math.abs(p.latitude! - location.latitude)),
    ) * 2.25;
  const scale = Math.min(size.width / rangeX, size.height / rangeY);
  const coversJaipur =
    scale >= 600 &&
    location.latitude >= 26.86 &&
    location.latitude <= 26.98 &&
    location.longitude >= 75.75 &&
    location.longitude <= 75.87;
  function move(e: MouseEvent<HTMLDivElement>) {
    if (!onSimulate || e.target !== e.currentTarget || !scale) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    const latitude =
      location.latitude - (e.clientY - bounds.top - size.height / 2) / scale;
    const longitude =
      location.longitude +
      (e.clientX - bounds.left - size.width / 2) / scale / orientation;
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)
      onSimulate({
        latitude: Number(latitude.toFixed(6)),
        longitude: Number(longitude.toFixed(6)),
      });
  }
  return (
    <div className="local-map" aria-label="Offline map of place coordinates">
      {coversJaipur && (
        <JaipurBasemap
          center={location}
          plot={frame}
          size={size}
          scale={scale}
          orientation={orientation}
        />
      )}
      <div
        ref={frame}
        className={"local-plot" + (onSimulate ? " local-plot-pick" : "")}
        style={{ bottom: Math.max(40, bottomInset + 20) }}
        onClick={move}
      >
        {points.map((point) => (
          <button
            type="button"
            key={point.place_id}
            className={
              "local-pin" +
              (point.place_id === selected ? " selected" : "") +
              (point.place_id === location.place_id ? " origin" : "")
            }
            style={{
              left:
                size.width / 2 +
                (point.longitude! - location.longitude) * orientation * scale,
              top:
                size.height / 2 - (point.latitude! - location.latitude) * scale,
            }}
            title={point.name}
            aria-label={point.name}
            onClick={() =>
              onSimulate
                ? onSimulate({
                    latitude: point.latitude!,
                    longitude: point.longitude!,
                  })
                : choose(point.place_id)
            }
          >
            <MapPin size={17} aria-hidden />
          </button>
        ))}
      </div>
      <small className="local-attribution">
        Offline map ·{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          © OpenStreetMap contributors
        </a>
      </small>
    </div>
  );
}
