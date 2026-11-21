"use client";

import { useEffect, useRef, type RefObject } from "react";

type StreetMap = {
  bounds: [south: number, west: number, north: number, east: number];
  layers: [
    water: number[][],
    local: number[][],
    connecting: number[][],
    main: number[][],
  ];
};
type Point = { latitude: number; longitude: number };
type Size = { width: number; height: number };
let loading: Promise<StreetMap> | undefined;

function loadStreetMap() {
  return (loading ??= fetch("/maps/jaipur-streets.json")
    .then((response) => {
      if (!response.ok) throw new Error("Jaipur basemap unavailable");
      return response.json() as Promise<StreetMap>;
    })
    .catch((error) => {
      loading = undefined;
      throw error;
    }));
}

export function JaipurBasemap({
  center,
  plot,
  size,
  scale,
  orientation,
}: {
  center: Point;
  plot: RefObject<HTMLDivElement | null>;
  size: Size;
  scale: number;
  orientation: number;
}) {
  const element = useRef<HTMLCanvasElement>(null);
  const { latitude, longitude } = center;
  useEffect(() => {
    const canvas = element.current;
    if (!canvas || !plot.current || !scale) return;
    let active = true;
    void loadStreetMap()
      .then(({ bounds, layers }) => {
        if (!active || !plot.current) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        const [south, west] = bounds;
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        const canvasWidth = canvas.clientWidth;
        const canvasHeight = canvas.clientHeight;
        canvas.width = canvasWidth * ratio;
        canvas.height = canvasHeight * ratio;
        context.scale(ratio, ratio);
        context.lineCap = "round";
        context.lineJoin = "round";
        const middleX = plot.current.offsetLeft + size.width / 2;
        const middleY = plot.current.offsetTop + size.height / 2;
        const x = (value: number) =>
          middleX + (west + value / 100000 - longitude) * orientation * scale;
        const y = (value: number) =>
          middleY - (south + value / 100000 - latitude) * scale;
        const colors = ["#c5dde3", "#d1dccd", "#b2c3b0", "#95ad99"];
        layers.forEach((paths, index) => {
          context.beginPath();
          for (const path of paths) {
            context.moveTo(x(path[1]), y(path[0]));
            for (let i = 2; i < path.length; i += 2)
              context.lineTo(x(path[i + 1]), y(path[i]));
          }
          if (index === 0) {
            context.fillStyle = colors[0];
            context.fill();
          } else {
            context.strokeStyle = colors[index];
            context.lineWidth = index === 1 ? 1 : index === 2 ? 1.5 : 2;
            context.stroke();
          }
        });
      })
      .catch(() => {
        // The coordinate grid and pins remain available.
      });
    return () => {
      active = false;
    };
  }, [latitude, longitude, plot, size, scale, orientation]);
  return <canvas ref={element} className="local-basemap" aria-hidden="true" />;
}
