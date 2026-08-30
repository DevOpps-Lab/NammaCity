"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { WardRow } from "@/lib/admin-data";

/**
 * Ward choropleth.
 *
 * public/data/chennai-wards.geojson has existed since the routing tier was
 * built and has never been drawn: routing.ts reads it server-side with node:fs
 * to answer "which ward is this point in", and nothing has ever shown it to
 * anyone. 201 features, 200 real wards plus a Ward_No 0 artefact that the
 * routing code already skips and so does this.
 *
 * SHADED BY BREACH RATE, NOT BY VOLUME. A ward that files a lot of complaints
 * and answers them is doing well; colouring by count would paint it as the
 * problem and let a quiet, unresponsive ward hide. Volume is in the table
 * instead, where it reads as context rather than as a verdict.
 */

const WARDS_URL = "/data/chennai-wards.geojson";
const SOURCE = "wards";

interface WardFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: unknown;
}

export default function WardMap({
  rows,
  loading,
  selected,
  onSelect,
  onDrill,
}: {
  rows: WardRow[];
  loading: boolean;
  selected: string | null;
  onSelect: (ward: string | null) => void;
  onDrill: (ward: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [geo, setGeo] = useState<{ features: WardFeature[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const byWard = useMemo(() => {
    const m = new Map<string, WardRow>();
    for (const r of rows) m.set(r.ward, r);
    return m;
  }, [rows]);

  // Fetched, not imported: 608KB of polygon has no business in the JS bundle,
  // and it is already served statically from public/.
  useEffect(() => {
    let alive = true;
    fetch(WARDS_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (alive) setGeo(j);
      })
      .catch((e) => alive && setFailed(e instanceof Error ? e.message : "could not load wards"));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || mapRef.current) return;

    const map = new maplibregl.Map({
      container: box,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [80.2496, 13.06],
      zoom: 9.6,
      maxPitch: 0,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      setReady(true);
      map.resize();
    });
    mapRef.current = map;

    const ro = new ResizeObserver(() => mapRef.current?.resize());
    ro.observe(box);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Join the counts onto the polygons and (re)publish the source.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !geo) return;

    const data = {
      type: "FeatureCollection" as const,
      features: geo.features
        .filter((f) => Number(f.properties.Ward_No) > 0)
        .map((f) => {
          const key = String(f.properties.Ward_No);
          const row = byWard.get(key);
          return {
            ...f,
            properties: {
              ...f.properties,
              ward: key,
              total: row?.total ?? 0,
              breach_rate: row?.breach_rate ?? -1,
            },
          };
        }),
    };

    const existing = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (existing) {
      existing.setData(data as never);
    } else {
      map.addSource(SOURCE, { type: "geojson", data: data as never });
      map.addLayer({
        id: "wards-fill",
        type: "fill",
        source: SOURCE,
        paint: {
          // -1 means no reports at all, which is absence of data and must not
          // be shaded as if it were a zero breach rate.
          "fill-color": [
            "case",
            ["<", ["get", "breach_rate"], 0],
            "#d7d9dd",
            [
              "interpolate",
              ["linear"],
              ["get", "breach_rate"],
              0,
              "#4fae7c",
              25,
              "#e0913c",
              60,
              "#e85f52",
            ],
          ],
          "fill-opacity": 0.68,
        },
      });
      map.addLayer({
        id: "wards-line",
        type: "line",
        source: SOURCE,
        paint: { "line-color": "#ffffff", "line-width": 0.6, "line-opacity": 0.8 },
      });
      map.addLayer({
        id: "wards-selected",
        type: "line",
        source: SOURCE,
        filter: ["==", ["get", "ward"], ""],
        paint: { "line-color": "#17130a", "line-width": 2.5 },
      });

      map.on("click", "wards-fill", (e) => {
        const w = e.features?.[0]?.properties?.ward;
        if (typeof w === "string") onSelect(w);
      });
      map.on("mouseenter", "wards-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "wards-fill", () => {
        map.getCanvas().style.cursor = "";
      });
    }
  }, [ready, geo, byWard, onSelect]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer("wards-selected")) return;
    map.setFilter("wards-selected", ["==", ["get", "ward"], selected ?? ""]);
  }, [selected, ready]);

  const top = useMemo(
    () => [...rows].filter((r) => r.total > 0).sort((a, b) => (b.breach_rate ?? 0) - (a.breach_rate ?? 0)).slice(0, 10),
    [rows]
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <section className="panel overflow-hidden">
        <div className="relative h-[440px] w-full">
          <div ref={boxRef} className="absolute inset-0" />
          {(!ready || !geo) && !failed && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center bg-[var(--surface)]">
              <p className="t-sm text-[var(--text-dim)]">Loading ward boundaries…</p>
            </div>
          )}
          {failed && (
            <div className="absolute inset-0 grid place-items-center bg-[var(--surface)] p-6">
              <p className="t-sm text-center text-[var(--text-dim)]">
                Ward boundaries could not be loaded. The table is unaffected.
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-4 py-3">
          <span className="text-[12px] text-[var(--text-faint)]">Past their deadline</span>
          <Legend colour="#4fae7c" label="none" />
          <Legend colour="#e0913c" label="some" />
          <Legend colour="#e85f52" label="most" />
          <Legend colour="#d7d9dd" label="no reports" />
        </div>
      </section>

      <section className="panel h-fit p-4">
        <h2 className="t-head">Worst performing</h2>
        <p className="t-sm mt-1 text-[var(--text-dim)]">By share of reports past the deadline.</p>

        {loading ? (
          <div className="shimmer mt-4 h-40 w-full rounded" />
        ) : top.length === 0 ? (
          <p className="t-sm mt-4 text-[var(--text-dim)]">No ward has reports in this period.</p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {top.map((r) => (
              <li key={`${r.ward}-${r.zone}`}>
                <button
                  onClick={() => onDrill(r.ward)}
                  className="flex w-full items-baseline gap-2 border-b border-[var(--border)] py-2 text-left last:border-0 hover:text-[var(--accent)]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">
                      {r.ward === "unknown" ? "Unresolved ward" : `Ward ${r.ward}`}
                    </span>
                    <span className="block truncate text-[12px] text-[var(--text-faint)]">
                      {r.zone}
                    </span>
                  </span>
                  <span className="tnum shrink-0 text-[13px] font-semibold">
                    {r.breach_rate ?? 0}%
                  </span>
                  <span className="tnum shrink-0 text-[11px] text-[var(--text-faint)]">
                    /{r.total}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 border-t border-[var(--border)] pt-3 text-[12px] leading-relaxed text-[var(--text-faint)]">
          Shaded by the share of reports past their deadline, not by how many were filed. A busy
          ward that answers its complaints is not a failing one.
        </p>
      </section>
    </div>
  );
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="h-3 w-5 rounded-[3px]" style={{ background: colour }} />
      <span className="text-[12px] text-[var(--text-faint)]">{label}</span>
    </span>
  );
}
