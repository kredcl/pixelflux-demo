"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Run = {
  id: number;
  status: "pending" | "running" | "done" | "error";
  created_at: string;
  finished_at?: string | null;
  total: number;
  ok: number;
  error: number;
  status_msg?: string | null;
};

type Row = {
  id: number;
  run_id: number;
  name: string;
  category?: string | null;
  phone?: string | null;
  phone_raw?: string | null;
  phone_e164?: string | null;
  city?: string | null;
  rating?: number | null;
  website?: string | null;
  address?: string | null;
  maps_url?: string | null;
  query?: string | null;

  // zona
  in_zone?: boolean;
  zone_name?: string | null;

  // NUEVO: contadores de opiniones
  reviews_count?: number;           // total de opiniones guardadas
  owner_responses_count?: number;   // cuántas tienen respuesta del negocio
};

const API = process.env.NEXT_PUBLIC_API_BASE || "https://api.pixelfluxcreative.com";

const CANADIAN_CITIES: Record<string, string> = {
  "CA-VAN": "Vancouver",
  "CA-VIC": "Victoria",
  "CA-NAN": "Nanaimo",
  "CA-KEL": "Kelowna",
  "CA-CAL": "Calgary",
  "CA-EDM": "Edmonton"
};

export default function ScraperPage() {
  // consultas
  const [queries, setQueries] = useState("Pizzerias La Serena Chile");

  // runs/resultados
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);

  // búsqueda en tabla
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);

  // filtro de zona: all | in | out
  const [zoneFilter, setZoneFilter] = useState<"all" | "in" | "out">("all");

  // opciones avanzadas (panel plegable)
  const [optsOpen, setOptsOpen] = useState(false);
  const [mode, setMode] = useState<"strict" | "explorer">("strict");
  const [radiusKm, setRadiusKm] = useState<string>(""); // vacío = auto
  const [categories, setCategories] = useState<"strict" | "extended">("strict");
  const [country, setCountry] = useState<string>("CL");

  const pollRunsRef = useRef<NodeJS.Timeout | null>(null);
  const pollRowsRef = useRef<NodeJS.Timeout | null>(null);

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) || null,
    [runs, selectedRunId]
  );

  const fetchRuns = useCallback(async () => {
    const res = await fetch(`${API}/scraper/jobs`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return;
    const data = await res.json();
    setRuns(data.items || []);
    if (!selectedRunId && data.items?.length) {
      setSelectedRunId(data.items[0].id);
    }
  }, [selectedRunId]);

  const fetchRows = useCallback(
    async (rid: number, lim = limit, zf: "all" | "in" | "out" = zoneFilter) => {
      setLoadingRows(true);
      const params = new URLSearchParams({ offset: "0", limit: String(lim) });
      if (zf === "in") params.set("in_zone", "true");
      if (zf === "out") params.set("in_zone", "false");

      const res = await fetch(`${API}/scraper/jobs/${rid}/results?` + params.toString(), {
        credentials: "include",
        cache: "no-store",
      });
      setLoadingRows(false);
      if (!res.ok) return;
      const data = await res.json();
      setRows(data.items || []);
    },
    [limit, zoneFilter]
  );

  // polling de runs
  useEffect(() => {
    fetchRuns();
    if (pollRunsRef.current) clearInterval(pollRunsRef.current);
    pollRunsRef.current = setInterval(fetchRuns, 3000);
    return () => {
      if (pollRunsRef.current) clearInterval(pollRunsRef.current);
    };
  }, [fetchRuns]);

  // cargar filas al seleccionar run o cambiar límite/filtro de zona
  useEffect(() => {
    if (selectedRunId) fetchRows(selectedRunId, limit, zoneFilter);
  }, [selectedRunId, limit, zoneFilter, fetchRows]);

  // polling de filas mientras corra
  useEffect(() => {
    if (!selectedRunId) return;
    if (pollRowsRef.current) clearInterval(pollRowsRef.current);

    if (selectedRun?.status === "running" || selectedRun?.status === "pending") {
      pollRowsRef.current = setInterval(() => fetchRows(selectedRunId, limit, zoneFilter), 2500);
    }
    return () => {
      if (pollRowsRef.current) clearInterval(pollRowsRef.current);
    };
  }, [selectedRun?.status, selectedRunId, limit, zoneFilter, fetchRows]);

  // cuando termina: pedir TODO automáticamente
  useEffect(() => {
    if (!selectedRunId || !selectedRun) return;
    if (selectedRun.status === "done") {
      if (pollRowsRef.current) clearInterval(pollRowsRef.current);
      const all = Math.max(10000, selectedRun.ok || 0);
      setLimit(all);
      fetchRows(selectedRunId, all, zoneFilter);
    }
  }, [selectedRun?.status, selectedRun?.ok, selectedRunId, zoneFilter, fetchRows]);

  const onCreate = async () => {
    const citySuffix = CANADIAN_CITIES[country] ? ` ${CANADIAN_CITIES[country]}` : "";

    const qs = queries
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((q) => q + citySuffix);

    if (!qs.length) return alert("Enter at least one query (one per line).");

    // Opciones para TODAS las queries del job
    const options: any = { mode, categories, country };
    if (radiusKm && !Number.isNaN(Number(radiusKm))) options.radius_km = Number(radiusKm);

    const res = await fetch(`${API}/scraper/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify({ queries: qs, options }),
    });
    if (!res.ok) {
      const t = await res.text();
      alert("Error creating job: " + t);
      return;
    }
    const data = await res.json();
    if (!data?.id) return alert("The API did not return a job id.");

    setSelectedRunId(data.id);
    setLimit(100);
    setZoneFilter("all");
    await fetchRuns();
    await fetchRows(data.id, 100, "all");
  };

  const filteredRows = useMemo(() => {
    if (!search) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) =>
      [r.name, r.city, r.phone, r.phone_e164, r.phone_raw, r.website]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase())
        .some((v) => v.includes(s))
    );
  }, [rows, search]);

  // Contadores visibles (del dataset cargado)
  const countIn = useMemo(() => rows.filter((r) => r.in_zone === true).length, [rows]);
  const countOut = useMemo(() => rows.filter((r) => r.in_zone === false).length, [rows]);

  return (
    <div className="min-h-screen bg-[#f2f8f6] text-slate-900">
      {/* Layout */}
      <div className="grid grid-cols-[260px_1fr] min-h-screen">
        {/* Sidebar */}
        <aside className="border-r bg-white/0 p-4 flex flex-col gap-4">
          <a href="/panel" className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50">
            Back
          </a>

          {/* Demo explainer callout */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 leading-relaxed">
            The real scraper searches Google Maps for businesses matching a query (industry + location),
            automatically extracting contact info, ratings, and reviews. It&apos;s disabled in this demo —
            the interface below is fully real, but submitting a search won&apos;t launch a live scrape.
            Browse the pre-loaded results instead.
          </div>

          <div>
            <h2 className="font-semibold text-lg mb-3">Google Maps Scraper</h2>
            <label className="text-sm text-slate-600">Queries (one per line)</label>
            <textarea
              className="mt-2 w-full h-36 rounded-lg border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white"
              value={queries}
              onChange={(e) => setQueries(e.target.value)}
              placeholder={"E.g.:\nPizzerias La Serena Chile\nCerrajeros Chillán Chile"}
            />
            <div className="mt-3 flex items-center justify-between gap-2">
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 text-[11px] px-2 py-0.5 font-medium"
                title="This demo's search button won't launch a live scrape"
              >
                Demo mode — search disabled
              </span>
            </div>
            <button
              onClick={onCreate}
              className="mt-2 w-full rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white py-2 font-medium"
            >
              Start scraping
            </button>
          </div>

          {/* Opciones avanzadas */}
          <div className="border rounded-lg bg-white">
            <button
              className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium"
              onClick={() => setOptsOpen((v) => !v)}
            >
              <span>Advanced options</span>
              <span className="text-slate-500">{optsOpen ? "▲" : "▼"}</span>
            </button>
            {optsOpen && (
              <div className="px-3 pb-3 space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-600 mb-1">Mode</label>
                    <select
                      value={mode}
                      onChange={(e) => setMode(e.target.value as any)}
                      className="w-full rounded border border-slate-300 p-2 bg-white"
                    >
                      <option value="strict">Strict (recommended)</option>
                      <option value="explorer">Explorer (broader)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-600 mb-1">Radius (km)</label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={radiusKm}
                      onChange={(e) => setRadiusKm(e.target.value)}
                      placeholder="Auto"
                      className="w-full rounded border border-slate-300 p-2 bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-600 mb-1">Categories</label>
                    <select
                      value={categories}
                      onChange={(e) => setCategories(e.target.value as any)}
                      className="w-full rounded border border-slate-300 p-2 bg-white"
                    >
                      <option value="strict">Strict (category only)</option>
                      <option value="extended">Extended</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-600 mb-1">Country / Region</label>
                    <select
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      className="w-full rounded border border-slate-300 p-2 bg-white"
                    >
                      <optgroup label="Latin America">
                        <option value="CL">Chile</option>
                        <option value="AR">Argentina</option>
                        <option value="PE">Peru</option>
                        <option value="MX">Mexico</option>
                      </optgroup>
                      <optgroup label="Canada (West)">
                        <option value="CA-VAN">Canada - Vancouver</option>
                        <option value="CA-VIC">Canada - Victoria</option>
                        <option value="CA-NAN">Canada - Nanaimo</option>
                        <option value="CA-KEL">Canada - Kelowna</option>
                        <option value="CA-CAL">Canada - Calgary</option>
                        <option value="CA-EDM">Canada - Edmonton</option>
                      </optgroup>
                    </select>
                  </div>
                </div>
                <p className="text-[12px] text-slate-500">
                  These options apply to <b>all</b> queries in this job. If you leave &quot;Radius&quot; empty, it&apos;s calculated automatically based on the mode.
                </p>
              </div>
            )}
          </div>

          {/* Jobs recientes */}
          <div className="flex-1 min-h-0">
            <h3 className="font-semibold mb-2">Recent jobs</h3>
            <div className="h-full max-h-[45vh] overflow-y-auto space-y-2 pr-1">
              {runs.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedRunId(r.id)}
                  className={`w-full text-left rounded-lg border px-3 py-2 bg-white ${selectedRunId === r.id ? "border-emerald-500 bg-emerald-50" : "border-slate-200"
                    }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-medium">#{r.id}</div>
                    <span
                      className={`text-xs rounded px-2 py-0.5 ${r.status === "done"
                          ? "bg-emerald-100 text-emerald-700"
                          : r.status === "error"
                            ? "bg-rose-100 text-rose-700"
                            : "bg-amber-100 text-amber-700"
                        }`}
                    >
                      {r.status}
                    </span>
                  </div>
                  <div className="text-xs text-slate-600">
                    total {r.total} · ok {r.ok} · err {r.error}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* Panel derecho */}
        <main className="p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm">
              <div className="font-semibold">Results for job #{selectedRunId ?? "—"}</div>
              <div className="text-slate-600">
                Status:{" "}
                <span
                  className={
                    selectedRun?.status === "done"
                      ? "text-emerald-600"
                      : selectedRun?.status === "error"
                        ? "text-rose-600"
                        : "text-amber-600"
                  }
                >
                  {selectedRun?.status ?? "—"}
                </span>{" "}
                · total {selectedRun?.total ?? 0} · ok {selectedRun?.ok ?? 0} · err {selectedRun?.error ?? 0}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => selectedRunId && fetchRows(selectedRunId, limit, zoneFilter)}
                className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50"
              >
                Refresh
              </button>
              <button
                onClick={() => {
                  if (!selectedRunId) return;
                  const all = Math.max(10000, selectedRun?.ok || 0);
                  setLimit(all);
                  fetchRows(selectedRunId, all, zoneFilter);
                }}
                className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50"
              >
                Show all
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search (name/city/phone)"
              className="w-80 rounded-lg border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white"
            />

            {/* Segmented control: Todos / En zona / Fuera de zona */}
            <div className="flex rounded-lg border overflow-hidden">
              <button
                className={`px-3 py-2 text-sm ${zoneFilter === "all" ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"}`}
                onClick={() => setZoneFilter("all")}
              >
                All
              </button>
              <button
                className={`px-3 py-2 text-sm border-l ${zoneFilter === "in" ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"}`}
                onClick={() => setZoneFilter("in")}
                title="Results inside the area (AOI)"
              >
                In zone
              </button>
              <button
                className={`px-3 py-2 text-sm border-l ${zoneFilter === "out" ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"}`}
                onClick={() => setZoneFilter("out")}
                title="Results outside the area"
              >
                Out of zone
              </button>
            </div>

            <div className="ml-auto text-xs text-slate-500">
              In zone: {countIn} · Out of zone: {countOut}
            </div>
          </div>

          {/* Contenedor con scroll interno de tabla */}
          <div className="mt-4 border rounded-lg overflow-hidden bg-white">
            <div className="max-h-[85vh] overflow-y-auto">
              <table className="w-full text-sm table-fixed">
                {/* Control de anchos por columna */}
                <colgroup>
                  <col className="w-[20%]" />    {/* Nombre */}
                  <col className="w-[16ch]" />   {/* Teléfono */}
                  <col className="w-[10%]" />    {/* Ciudad */}
                  <col className="w-[7%]" />     {/* Rating */}
                  <col className="w-[8%]" />     {/* Opiniones (nuevo) */}
                  <col className="w-[18%]" />    {/* Web */}
                  <col className="w-[26%]" />    {/* Dirección */}
                  <col className="w-[10%]" />    {/* Query */}
                  <col className="w-[9%]" />     {/* Zona */}
                </colgroup>

                {/* Encabezado sticky */}
                <thead className="bg-white sticky top-0 z-10 border-b">
                  <tr className="text-left">
                    <th className="p-2">Name</th>
                    <th className="p-2">Phone</th>
                    <th className="p-2">City</th>
                    <th className="p-2">Rating</th>
                    <th className="p-2">Reviews</th>
                    <th className="p-2">Website</th>
                    <th className="p-2">Address</th>
                    <th className="p-2">Query</th>
                    <th className="p-2">Zone</th>
                  </tr>
                </thead>

                <tbody>
                  {loadingRows && rows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-6 text-center text-slate-500">
                        Loading results…
                      </td>
                    </tr>
                  ) : filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-6 text-center text-slate-500">
                        No results
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((r) => {
                      const rc = r.reviews_count || 0;
                      const oc = r.owner_responses_count || 0;
                      const hasReviews = rc > 0;
                      const hasOwner = oc > 0;
                      const badge =
                        hasOwner ? "✔✔" :
                          hasReviews ? "✔" : "—";
                      const title = hasReviews
                        ? `${rc} reviews${hasOwner ? ` · ${oc} with business reply` : ""}`
                        : "No reviews";

                      return (
                        <tr key={r.id} className="border-t">
                          <td className="p-2">
                            <div className="flex items-center gap-2">
                              <span>{r.name || "—"}</span>
                            </div>
                          </td>

                          {/* Teléfono: ancho fijo + sin wrap */}
                          <td className="p-2 whitespace-nowrap font-mono tracking-wide">
                            {r.phone_e164 || r.phone || r.phone_raw || "—"}
                          </td>

                          <td className="p-2">{r.city || "—"}</td>
                          <td className="p-2">{r.rating ?? "—"}</td>

                          {/* Opiniones: ✔ / ✔✔ */}
                          <td className="p-2">
                            <span
                              className={`inline-block text-[12px] leading-none px-2 py-1 rounded-full ${hasOwner
                                  ? "bg-emerald-100 text-emerald-700"
                                  : hasReviews
                                    ? "bg-emerald-50 text-emerald-700"
                                    : "bg-slate-100 text-slate-600"
                                }`}
                              title={title}
                            >
                              {badge}
                            </span>
                          </td>

                          {/* Web: truncada */}
                          <td className="p-2">
                            {r.website ? (
                              <a
                                href={r.website}
                                target="_blank"
                                className="text-emerald-700 underline block truncate"
                                title={r.website}
                              >
                                {r.website.replace(/^https?:\/\//, "")}
                              </a>
                            ) : (
                              "—"
                            )}
                          </td>

                          <td className="p-2">{r.address || "—"}</td>
                          <td className="p-2">{r.query || "—"}</td>

                          {/* Badge de zona */}
                          <td className="p-2">
                            {r.in_zone === true ? (
                              <span className="inline-block text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                                In zone
                              </span>
                            ) : r.in_zone === false ? (
                              <span className="inline-block text-[11px] px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">
                                Out of zone
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-2 text-right text-xs text-slate-500">
            Showing {filteredRows.length} of {selectedRun?.ok ?? rows.length} records (limit {limit})
          </div>
        </main>
      </div>
    </div>
  );
}