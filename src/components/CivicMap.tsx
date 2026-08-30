"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Report } from "@/lib/types";
import { STATUS_STYLES } from "@/lib/status";
import { now } from "@/lib/demoClock";

/**
 * Basemaps, in preference order. All three are keyless — no billing account,
 * which matters when the whole thing runs off a laptop on venue wifi.
 * If the first fails to load we fall through rather than showing a black void.
 */
const STYLES = [
  // Positron: the lowest-chroma keyless basemap available, which is what keeps
  // eight status hues legible on top of it. Liberty and Bright colour their
  // landuse polygons and fight the pins.
  //
  // This was briefly swapped to dark-matter so the map matched the dark shell.
  // Measured, that style paints its background rgb(12,12,12), darker than the
  // app's own #0d0e10, and streets in an unlit ward became unreadable. A map is
  // a document, not chrome. It is allowed to be lighter than the frame around
  // it, and the pin chrome below is tuned to sit on pale tiles.
  "https://tiles.openfreemap.org/styles/positron",
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
];

const CHENNAI: [number, number] = [80.2496, 13.0604];
const CLUSTER_ZOOM = 12.5;

/** How long to wait for a basemap before trying the other provider. */
const STYLE_TIMEOUT_MS = 9000;

const SEVERITY_ORDER: Report["status"][] = [
  "escalated",
  "past_sla",
  "transferred",
  "claims_done",
  "reported",
  "acknowledged",
  "filed",
  "verified_fixed",
];

interface Props {
  reports: Report[];
  selectedId?: string;
  onSelect: (r: Report) => void;
  /**
   * The map stays MOUNTED when its tab is inactive — MapLibre re-initialises on
   * every mount, so unmounting would rebuild the whole GL context on each tab
   * switch. Hidden via visibility (not display:none, which collapses the
   * container to 0x0 and leaves the canvas broken when it returns).
   */
  visible?: boolean;
}

export default function CivicMap({ reports, selectedId, onSelect, visible = true }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const droppedRef = useRef<Set<string>>(new Set());
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /**
   * Whether pins are currently clustered.
   *
   * This used to be the raw zoom level, set from map.on("zoom") on EVERY frame
   * of a pinch, with the marker effect depending on it. Each of those frames
   * tore down and rebuilt a maplibregl.Marker for every report on screen, which
   * is what stalled the main thread on phones and left the map looking
   * half-drawn. Only the threshold is ever read, so only the threshold is
   * stored: React bails out when the boolean does not change, and the markers
   * are rebuilt once per crossing instead of once per frame.
   */
  const [clustered, setClustered] = useState(11.2 < CLUSTER_ZOOM);

  // --- init ---------------------------------------------------------------
  useEffect(() => {
    const box = boxRef.current;
    const markers = markersRef.current;
    if (!box || mapRef.current) return;

    let styleIndex = 0;
    let disposed = false;
    let stallTimer = 0;

    const build = () => {
      const map = new maplibregl.Map({
        container: box,
        style: STYLES[styleIndex],
        center: CHENNAI,
        zoom: 11.2,
        attributionControl: { compact: true },
        // Flat only — tilt adds nothing here and costs perf on phones.
        maxPitch: 0,
      });

      map.addControl(
        new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }),
        "bottom-right"
      );
      map.addControl(
        new maplibregl.GeolocateControl({
          positionOptions: { enableHighAccuracy: true },
          trackUserLocation: true,
          showUserLocation: true,
        }),
        "bottom-right"
      );

      map.on("load", () => {
        if (disposed) return;
        window.clearTimeout(stallTimer);
        setReady(true);
        setFailed(null);
        // Container may have been sized after init (flex/dvh settling).
        map.resize();
      });

      /*
        `ready` was only ever set from the load event, with nothing watching for
        it never arriving. On a slow phone connection that meant a spinner that
        span forever AND no pins at all, because the marker effect returns early
        until ready. A stalled load now falls through to the other provider, and
        if that also stalls the user is told instead of watching an animation.
      */
      stallTimer = window.setTimeout(() => {
        if (disposed || map.isStyleLoaded()) return;
        if (styleIndex < STYLES.length - 1) {
          styleIndex++;
          map.setStyle(STYLES[styleIndex]);
          return;
        }
        setFailed("timed out loading map tiles");
      }, STYLE_TIMEOUT_MS);

      /*
        A style that fails to load leaves a blank canvas with no clue why, so
        fall through to the next provider rather than failing silently.

        But `error` fires for ANY failure, including a single tile or glyph
        404. The previous version treated those the same as a dead style, so on
        a flaky mobile connection one dropped tile mid-load restarted the entire
        style against the other provider, and once on the last style any
        transient tile error painted the full-screen failure state over a map
        that was working. Resource errors carry a sourceId; those are ignored.
      */
      map.on("error", (e) => {
        const err = e as unknown as { error?: Error; sourceId?: string };
        if (err.sourceId || map.isStyleLoaded()) return;
        if (styleIndex < STYLES.length - 1) {
          styleIndex++;
          map.setStyle(STYLES[styleIndex]);
          return;
        }
        setFailed(err.error?.message ?? "unknown");
      });

      map.on("zoom", () => setClustered(map.getZoom() < CLUSTER_ZOOM));
      mapRef.current = map;
    };

    build();

    // dvh settles late on mobile and flex parents resize after paint; without
    // this the canvas can stay at its initial (sometimes zero) size.
    const ro = new ResizeObserver(() => mapRef.current?.resize());
    ro.observe(box);

    return () => {
      disposed = true;
      window.clearTimeout(stallTimer);
      ro.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      markers.clear();
    };
  }, []);

  // --- markers / clusters -------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    // Ids that have already played their drop, so it only ever happens once.
    const dropped = droppedRef.current;
    let dropCount = 0;
    const dropIndexFor = (id: string) => {
      if (dropped.has(id)) return undefined;
      dropped.add(id);
      return dropCount++;
    };

    const seen = new Set<string>();
    const place = (key: string, lng: number, lat: number, el: HTMLElement) => {
      seen.add(key);
      markersRef.current.get(key)?.remove();
      const m = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
      markersRef.current.set(key, m);
    };

    if (clustered) {
      const p = map.getZoom() < 10 ? 1 : 2;
      const buckets = new Map<string, Report[]>();
      for (const r of reports) {
        const k = `${r.lat.toFixed(p)},${r.lng.toFixed(p)}`;
        const arr = buckets.get(k);
        if (arr) arr.push(r);
        else buckets.set(k, [r]);
      }

      for (const [key, group] of buckets) {
        if (group.length === 1) {
          const r = group[0];
          place(`p:${r.id}`, r.lng, r.lat, pinEl(r, selectedId, onSelectRef, dropIndexFor(r.id)));
          continue;
        }
        const worst = SEVERITY_ORDER.find((s) => group.some((g) => g.status === s)) ?? "filed";
        const lat = group.reduce((a, g) => a + g.lat, 0) / group.length;
        const lng = group.reduce((a, g) => a + g.lng, 0) / group.length;

        const el = document.createElement("button");
        el.className = "cluster";
        el.style.setProperty("--pin", STATUS_STYLES[worst].color);
        el.textContent = String(group.length);
        el.setAttribute("aria-label", `${group.length} reports in this area, zoom in`);
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          map.easeTo({ center: [lng, lat], zoom: CLUSTER_ZOOM + 1.3, duration: 550 });
        });
        place(`c:${key}`, lng, lat, el);
      }
    } else {
      for (const r of reports) {
        place(`p:${r.id}`, r.lng, r.lat, pinEl(r, selectedId, onSelectRef, dropIndexFor(r.id)));
      }
    }

    for (const [key, marker] of markersRef.current) {
      if (!seen.has(key)) {
        marker.remove();
        markersRef.current.delete(key);
      }
    }
  }, [reports, selectedId, clustered, ready]);

  // Re-measure when the tab becomes visible again: while hidden the container
  // has no usable size, so MapLibre needs to be told the viewport is back.
  useEffect(() => {
    if (visible) mapRef.current?.resize();
  }, [visible]);

  // --- fly to selection ---------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !selectedId) return;
    const r = reports.find((x) => x.id === selectedId);
    if (!r) return;
    map.easeTo({
      center: [r.lng, r.lat],
      zoom: Math.max(map.getZoom(), CLUSTER_ZOOM + 1),
      duration: 620,
      // Keep the pin above the bottom sheet on phones.
      offset: [0, window.innerWidth < 768 ? -120 : 0],
    });
  }, [selectedId, reports, ready]);

  return (
    <div
      className="relative h-full w-full"
      style={visible ? undefined : { visibility: "hidden", pointerEvents: "none" }}
      aria-hidden={!visible}
    >
      <div ref={boxRef} className="absolute inset-0 h-full w-full" />

      {!ready && !failed && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-[var(--bg)]">
          <div className="flex flex-col items-center gap-3">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-[var(--accent)]" />
            <p className="text-xs text-[var(--text-dim)]">Loading map…</p>
          </div>
        </div>
      )}

      {failed && (
        <div className="absolute inset-0 grid place-items-center bg-[var(--bg)] p-6">
          <div className="max-w-xs text-center">
            <p className="text-sm font-semibold text-[var(--danger)]">
              Map tiles unavailable
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-dim)]">
              The basemap couldn&apos;t load. Usually no internet, or a network
              blocking tile servers. Reports below still work; only the backdrop is
              missing.
            </p>
            <p className="mt-2 font-mono text-[10px] text-[var(--text-faint)]">{failed}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function pinEl(
  r: Report,
  selectedId: string | undefined,
  onSelectRef: React.RefObject<(r: Report) => void>,
  /**
   * Drop-in animation, first appearance only. Markers get rebuilt on every
   * zoom and status change, so animating unconditionally would make the whole
   * map re-drop every time you scrolled the wheel.
   */
  dropIndex?: number
) {
  const s = STATUS_STYLES[r.status];
  const el = document.createElement("button");

  el.className = [
    "pin",
    s.hollow ? "pin--hollow" : "pin--solid",
    s.pulse ? "pin--pulse" : "",
    r.id === selectedId ? "pin--selected" : "",
    dropIndex !== undefined ? "pin-drop" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (dropIndex !== undefined) {
    // Cap the stagger so a large caseload doesn't take seconds to finish.
    // Set as a custom property, not animationDelay: the animation lives on
    // ::after (see .pin-drop in globals.css) and inherits this.
    el.style.setProperty("--drop-delay", `${Math.min(dropIndex * 45, 700)}ms`);
  }

  el.style.setProperty("--pin", s.color);

  if (s.pulse) {
    // The longer past its deadline, the more insistent the pulse.
    const overdueDays = Math.max(0, (now() - r.slaDeadline) / 86_400_000);
    el.style.setProperty("--pulse", `${Math.max(0.8, 2.2 - overdueDays * 0.04).toFixed(2)}s`);
    const ring = document.createElement("span");
    ring.className = "pin-ring";
    el.appendChild(ring);
  }

  el.setAttribute("aria-label", `${s.label}, ${r.place}`);
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onSelectRef.current?.(r);
  });
  return el;
}
