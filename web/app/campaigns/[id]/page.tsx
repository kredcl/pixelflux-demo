// web/app/campaigns/[id]/page.tsx
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

type Campaign = {
  id: number;
  name: string;
  status: "PLANEACION" | "ACTIVA" | "DETENIDA" | "FINALIZADA";
  description?: string | null;
  created_at: string;
  updated_at?: string | null;
  leads_count: number;
};

type AuditsBasicMetrics = {
  sent_count: number;
  viewed_count: number;
  view_rate: number; // 0–1
  cta_clicks: number;
  cta_click_rate: number; // 0–1
};

type Metrics = {
  total_leads: number;
  analyzed_count: number;
  in_zone_count: number;
  out_zone_count: number;
  with_website_count: number;
  without_website_count: number;
  by_query: { query: string; count: number }[];
  // Nuevo: bloque de métricas de auditorías básicas (funnel enviadas → vistas → clics CTA)
  audits_basic?: AuditsBasicMetrics | null;
};

type LeadRow = {
  place_id: string;
  name: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  website: string | null;
  phone: string | null;
  message?: string | null;
  rating: number | null;
  reviews_count: number;
  owner_responses_count: number;
  in_zone: boolean;
  analyzed: boolean;
  campaign_name?: string | null;
  // Nuevo: vistas de la auditoría básica para este lead (en esta campaña)
  audit_basic_views?: number | null;
};

// --- Auditorías: tipos auxiliares ---
type AuditSample = {
  place_id: string;
  basic_url?: string | null;
  premium_url?: string | null;
  basic_expires_at?: string | null;
  premium_expires_at?: string | null;
};

type AuditResult = {
  ok: boolean;
  total?: number;
  requested?: number;
  created?: number;
  skipped?: number;
  samples?: AuditSample[];
  raw?: any;
  error?: string | null;
};

// ✅ extendemos LinkInfo para incluir tracking CTA por lead
type LinkInfo = {
  url: string;
  status: "ACTIVE" | "EXPIRED";
  cta_clicks?: number;
  last_cta_click_at?: string | null;
};
type AuditLinkMap = Record<string, { basic?: LinkInfo; premium?: LinkInfo }>;

const API =
  (process.env.NEXT_PUBLIC_API_BASE_URL as string) ||
  (process.env.NEXT_PUBLIC_API_BASE as string) ||
  "https://api.pixelfluxcreative.com";

const DEFAULT_AUDIT_HOST =
  process.env.NEXT_PUBLIC_AUDIT_HOST || "https://audit.pixelfluxcreative.com";

// Display labels for campaign status codes (the codes themselves stay as the
// backend's literal values; only what's shown to the user is translated).
const STATUS_LABELS: Record<Campaign["status"], string> = {
  PLANEACION: "Planning",
  ACTIVA: "Active",
  DETENIDA: "Stopped",
  FINALIZADA: "Finished",
};

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const campaignId = Number(params.id);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [camp, setCamp] = useState<Campaign | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  // tabla
  const [rows, setRows] = useState<LeadRow[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  // filtros simples locales
  const [q, setQ] = useState("");

  // selección
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  // modal agregar
  const [showAdd, setShowAdd] = useState(false);
  const [tabAdd, setTabAdd] = useState<"filters" | "ids">("filters");
  const [addIdsText, setAddIdsText] = useState("");
  const [addPreview, setAddPreview] = useState<{
    total: number;
    count: number;
    place_ids: string[];
  } | null>(null);
  const [addLimit, setAddLimit] = useState(100);

  // Auditorías (host, expiraciones, estados UI)
  const [auditHost, setAuditHost] = useState<string>(DEFAULT_AUDIT_HOST);
  const [basicDays, setBasicDays] = useState<number>(7);
  const [premiumDays, setPremiumDays] = useState<number>(10);
  const [busyAudit, setBusyAudit] = useState<null | "basic" | "premium">(null);
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);

  // Mapa de links por lead (para badges)
  const [auditMap, setAuditMap] = useState<AuditLinkMap>({});

  // Mensajes (outreach)
  const [busyMsg, setBusyMsg] = useState<null | "selected" | "all">(null);
  const [msgEditOpen, setMsgEditOpen] = useState(false);
  const [msgEditPlaceId, setMsgEditPlaceId] = useState<string | null>(null);
  const [msgEditName, setMsgEditName] = useState<string>("");
  const [msgEditText, setMsgEditText] = useState<string>("");
  const [msgSaving, setMsgSaving] = useState(false);

  useEffect(() => {
    try {
      const v = localStorage.getItem(`px_campaign_sidebar_${campaignId}`);
      if (v === "1") setSidebarCollapsed(true);
    } catch {}
  }, [campaignId]);
  useEffect(() => {
    try {
      localStorage.setItem(
        `px_campaign_sidebar_${campaignId}`,
        sidebarCollapsed ? "1" : "0"
      );
    } catch {}
  }, [sidebarCollapsed, campaignId]);

  const loadCampaign = async () => {
    const r = await fetch(`${API}/campaigns/${campaignId}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (r.ok) setCamp(await r.json());
  };
  const loadMetrics = async () => {
    const r = await fetch(`${API}/campaigns/${campaignId}/metrics`, {
      credentials: "include",
      cache: "no-store",
    });
    if (r.ok) setMetrics(await r.json());
  };
  const loadRows = async (reset = true) => {
    setLoading(true);
    const p = new URLSearchParams({
      limit: String(limit),
      offset: String(reset ? 0 : offset),
    });
    p.set("include_campaign", "true");
    p.set("campaign_id", String(campaignId));
    if (q) p.set("q", q);
    const r = await fetch(`${API}/leads?${p.toString()}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (r.ok) {
      const j = await r.json();
      setTotal(j.total || 0);
      setRows(reset ? j.items || [] : [...rows, ...(j.items || [])]);
      setOffset((reset ? 0 : offset) + (j.items?.length || 0));
    }
    setLoading(false);
  };

  useEffect(() => {
    loadCampaign();
    loadMetrics();
  }, [campaignId]);
  useEffect(() => {
    loadRows(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, q, limit]);

  const allSelected = useMemo(
    () => rows.length > 0 && rows.every((r) => selected[r.place_id]),
    [rows, selected]
  );

  const toggleAll = () => {
    if (allSelected) {
      setSelected({});
    } else {
      const m: Record<string, boolean> = {};
      rows.forEach((r) => (m[r.place_id] = true));
      setSelected(m);
    }
  };

  const removeSelected = async () => {
    const ids = Object.entries(selected)
      .filter(([_, v]) => v)
      .map(([k]) => k);
    if (!ids.length) return;
    if (!confirm(`Remove ${ids.length} lead(s) from the campaign?`)) return;
    const r = await fetch(`${API}/campaigns/${campaignId}/leads`, {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ place_ids: ids }),
    });
    if (r.ok) {
      await loadMetrics();
      await loadRows(true);
      setSelected({});
      await refreshAuditMap(); // refrescamos por si cae algún link asociado
    }
  };

  const saveCampaign = async (
    patch: Partial<Pick<Campaign, "name" | "description" | "status">>
  ) => {
    if (!camp) return;
    const r = await fetch(`${API}/campaigns/${campaignId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r.ok) {
      await loadCampaign();
    }
  };

  const deleteCampaign = async () => {
    if (!confirm("Delete campaign? Its lead associations will be removed.")) return;
    const r = await fetch(`${API}/campaigns/${campaignId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (r.ok) router.push("/campaigns");
  };

  // Agregar (por filtros) usando /leads/batch/select
  const refreshAddPreview = async () => {
    const ps = new URLSearchParams({ limit: String(addLimit) });
    if (q) ps.set("q", q);
    const r = await fetch(`${API}/leads/batch/select?${ps.toString()}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (r.ok) setAddPreview(await r.json());
  };
  const addByFilters = async () => {
    if (!addPreview?.place_ids?.length) return;
    const r = await fetch(`${API}/campaigns/${campaignId}/leads`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ place_ids: addPreview.place_ids }),
    });
    if (r.ok) {
      await loadMetrics();
      await loadRows(true);
      setShowAdd(false);
      await refreshAuditMap();
    }
  };
  const addByIds = async () => {
    const lines = addIdsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const uniq = Array.from(new Set(lines));
    if (!uniq.length) return;
    const r = await fetch(`${API}/campaigns/${campaignId}/leads`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ place_ids: uniq }),
    });
    if (r.ok) {
      await loadMetrics();
      await loadRows(true);
      setShowAdd(false);
      setAddIdsText("");
      await refreshAuditMap();
    }
  };

  function extractApiError(r: Response, data: any): string {
    const d = data?.detail;
    if (!d) return `HTTP ${r.status}`;
    if (typeof d === "string") return d;
    try {
      if (Array.isArray(d)) {
        // Pydantic: [{loc, msg, type, input}, ...]
        return d.map((e: any) => e?.msg || e?.detail || JSON.stringify(e)).join(" | ");
      }
      return JSON.stringify(d);
    } catch {
      return `HTTP ${r.status}`;
    }
  }

  // ----------- Auditorías: helpers -----------`
  const selectedIds = useMemo(
    () => Object.entries(selected).filter(([, v]) => v).map(([k]) => k),
    [selected]
  );

  async function fetchAuditSamples(
    kind: "BASIC" | "PREMIUM",
    limitN = 10
  ): Promise<AuditSample[]> {
    const r = await fetch(
      `${API}/audits/campaign/${campaignId}/links?kind=${kind}`,
      { credentials: "include", cache: "no-store" }
    );
    const d = await r.json().catch(() => ({ items: [] }));
    const items = (d?.items || []).slice(0, limitN);
    if (kind === "BASIC") {
      return items.map((i: any) => ({
        place_id: i.place_id,
        basic_url: i.url,
      })) as AuditSample[];
    } else {
      return items.map((i: any) => ({
        place_id: i.place_id,
        premium_url: i.url,
      })) as AuditSample[];
    }
  }

  async function refreshAuditMap() {
    const r1 = await fetch(
      `${API}/audits/campaign/${campaignId}/links?kind=BASIC`,
      { credentials: "include", cache: "no-store" }
    );
    const d1 = await r1.json().catch(() => ({ items: [] }));
    const r2 = await fetch(
      `${API}/audits/campaign/${campaignId}/links?kind=PREMIUM`,
      { credentials: "include", cache: "no-store" }
    );
    const d2 = await r2.json().catch(() => ({ items: [] }));

    const map: AuditLinkMap = {};
    for (const i of d1.items || []) {
      map[i.place_id] = map[i.place_id] || {};
      map[i.place_id].basic = {
        url: i.url,
        status: i.status,
        // ✅ tracking CTA por lead (si backend lo entrega)
        cta_clicks: Number(i.cta_clicks ?? 0),
        last_cta_click_at: i.last_cta_click_at ?? null,
      };
    }
    for (const i of d2.items || []) {
      map[i.place_id] = map[i.place_id] || {};
      map[i.place_id].premium = { url: i.url, status: i.status };
    }
    setAuditMap(map);
  }

  useEffect(() => {
    refreshAuditMap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  // ✅ Generar auditorías BÁSICAS para toda la campaña
  const runAuditBasicForCampaign = async () => {
    if (!auditHost) {
      alert("Configure the audit host.");
      return;
    }
    setBusyAudit("basic");
    setShowAuditModal(true);
    setAuditResult(null);

    try {
      const r = await fetch(
        `${API}/audits/campaign/${campaignId}/basic?days_valid=${basicDays}`,
        { method: "POST", credentials: "include" }
      );
      const data = await r.json().catch(() => ({}));

      if (!r.ok) {
        setAuditResult({
          ok: false,
          error: extractApiError(r, data),
          raw: data,
        });
      } else {
        const normalized: AuditResult = {
          ok: true,
          total: Number(data?.requested ?? 0),
          requested: Number(data?.requested ?? 0),
          created: Number(data?.created ?? data?.new ?? 0),
          skipped: Number(data?.skipped ?? 0),
          samples: [],
          raw: data,
        };
        try {
          normalized.samples = await fetchAuditSamples("BASIC", 10);
        } catch {}
        setAuditResult(normalized);
        await refreshAuditMap();
        await loadMetrics(); // refrescar funnel
      }
    } catch (e: any) {
      setAuditResult({ ok: false, error: String(e?.message || e), raw: null });
    } finally {
      setBusyAudit(null);
    }
  };

  // ✅ Generar auditorías PREMIUM solo para los leads seleccionados
  const runAuditPremiumForSelected = async () => {
    const ids = Array.from(new Set(selectedIds));
    if (ids.length === 0) {
      alert("Select at least one lead to generate Premium.");
      return;
    }
    if (!auditHost) {
      alert("Configure the audit host.");
      return;
    }
    setBusyAudit("premium");
    setShowAuditModal(true);
    setAuditResult(null);

    try {
      const r = await fetch(
        `${API}/audits/campaign/${campaignId}/premium?days_valid=${premiumDays}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          // el backend espera LIST[str] en la raíz
          body: JSON.stringify(ids),
        }
      );
      const data = await r.json().catch(() => ({}));

      if (!r.ok) {
        setAuditResult({
          ok: false,
          error: extractApiError(r, data),
          raw: data,
        });
      } else {
        const normalized: AuditResult = {
          ok: true,
          total: ids.length,
          requested: ids.length,
          created: Number(data?.created ?? data?.new ?? 0),
          skipped: Number(data?.skipped ?? 0),
          samples: [],
          raw: data,
        };
        try {
          normalized.samples = await fetchAuditSamples("PREMIUM", 10);
        } catch {}
        setAuditResult(normalized);
        await refreshAuditMap();
        // las métricas de click en CTA sólo aplican a básicas, así que no hace falta recargar metrics aquí
      }
    } catch (e: any) {
      setAuditResult({ ok: false, error: String(e?.message || e), raw: null });
    } finally {
      setBusyAudit(null);
    }
  };

  // ----------- Widgets de progreso de auditorías -----------`
  const totalLeadsCount = useMemo(
    () => (metrics?.total_leads ?? rows.length) || 0,
    [metrics, rows]
  );
  const basicOkCount = useMemo(() => {
    if (!rows.length) return 0;
    let n = 0;
    for (const r of rows)
      if (auditMap[r.place_id]?.basic?.status === "ACTIVE") n++;
    return n;
  }, [rows, auditMap]);
  const premiumOkCount = useMemo(() => {
    if (!rows.length) return 0;
    let n = 0;
    for (const r of rows)
      if (auditMap[r.place_id]?.premium?.status === "ACTIVE") n++;
    return n;
  }, [rows, auditMap]);

  async function generateMessages(mode: "selected" | "all") {
    if (busyMsg) return;
    if (mode === "selected" && selectedIds.length === 0) {
      alert("Select at least 1 lead.");
      return;
    }
    try {
      setBusyMsg(mode);
      const url = `${API}/campaigns/${campaignId}/messages/generate?mode=${mode}`;
      const opts: RequestInit = {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      };
      if (mode === "selected") {
        opts.body = JSON.stringify({ place_ids: selectedIds });
      }
      const r = await fetch(url, opts);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        alert(j?.detail || "Could not generate messages.");
        return;
      }
      const parts: string[] = [];
      const sr = j.skipped_reasons || {};
      if (sr.no_audit) parts.push(`no audit: ${sr.no_audit}`);
      if (sr.no_phone) parts.push(`no phone: ${sr.no_phone}`);
      if (sr.manual_locked) parts.push(`locked (manual): ${sr.manual_locked}`);
      if (sr.already_has_message) parts.push(`already had a message: ${sr.already_has_message}`);
      const extra = parts.length ? ` (${parts.join(", ")})` : "";
      alert(`Generated: ${j.generated || 0} / Skipped: ${j.skipped || 0}${extra}`);
      await loadRows(true);
    } finally {
      setBusyMsg(null);
    }
  }

  function openMessageEditor(placeId: string) {
    const row = rows.find((x) => x.place_id === placeId);
    setMsgEditPlaceId(placeId);
    setMsgEditName(row?.name || "business");
    setMsgEditText(row?.message || "");
    setMsgEditOpen(true);
  }

  async function saveMessageEditor() {
    if (!msgEditPlaceId) return;
    const text = (msgEditText || "").trim();
    if (!text) {
      alert("The message cannot be empty.");
      return;
    }
    try {
      setMsgSaving(true);
      const r = await fetch(
        `${API}/campaigns/${campaignId}/messages/${encodeURIComponent(msgEditPlaceId)}`,
        {
          method: "PATCH",
          credentials: "include",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        }
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        alert(j?.detail || "Could not save the message.");
        return;
      }
      setRows((prev) =>
        prev.map((x) =>
          x.place_id === msgEditPlaceId ? { ...x, message: text } : x
        )
      );
      setMsgEditOpen(false);
    } finally {
      setMsgSaving(false);
    }
  }

  return (
    <div
      className="min-h-screen bg-[#f2f8f6] text-slate-900 grid relative g-cols-smooth"
      // cambio 1: reservar 24px de gutter para el handle cuando está colapsado
      style={{ gridTemplateColumns: `${sidebarCollapsed ? "24px" : "280px"} 1fr` }}
    >
      {/* Sidebar */}
      <aside
        className={`bg-dark text-white p-6 flex flex-col gap-4 relative overflow-hidden opacity-smooth ${
          sidebarCollapsed ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
        aria-hidden={sidebarCollapsed}
      >
        <div className="text-xl font-semibold">Campaign</div>

        {/* handle visible cuando el panel está abierto */}
        <button
          onClick={() => setSidebarCollapsed(true)}
          className="absolute -right-3 top-6 collapse-handle bg-emerald-600 text-white hover:bg-emerald-700"
          title="Collapse panel"
          aria-label="Collapse panel"
        >
          ‹
        </button>

        <a
          href="/campaigns"
          className="bg-white/10 rounded px-3 py-2 text-center hover:bg-white/20"
        >
          Back
        </a>
        <Link
          href={`/leads?campaign_id=${campaignId}`}
          className="bg-white/10 rounded px-3 py-2 text-center hover:bg-white/20"
        >
          Open in Leads
        </Link>

        <div className="bg-white/10 rounded-lg p-3">
          <div className="text-white/80 text-xs">Total leads</div>
          <div className="text-2xl font-semibold">
            {metrics?.total_leads ?? "—"}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="bg-white/10 rounded-lg p-3">
            <div className="text-white/80 text-xs">Analyzed</div>
            <div className="text-lg font-semibold">
              {metrics?.analyzed_count ?? "—"}
            </div>
          </div>
          <div className="bg-white/10 rounded-lg p-3">
            <div className="text-white/80 text-xs">Not analyzed</div>
            <div className="text-lg font-semibold">
              {metrics ? metrics.total_leads - metrics.analyzed_count : "—"}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="bg-white/10 rounded-lg p-3">
            <div className="text-white/80 text-xs">With website</div>
            <div className="text-lg font-semibold">
              {metrics?.with_website_count ?? "—"}
            </div>
          </div>
          <div className="bg-white/10 rounded-lg p-3">
            <div className="text-white/80 text-xs">No website</div>
            <div className="text-lg font-semibold">
              {metrics?.without_website_count ?? "—"}
            </div>
          </div>
        </div>

        <div>
          <div className="text-sm opacity-80 mb-2">Top queries</div>
          <div className="flex flex-wrap gap-2">
            {(metrics?.by_query || []).map((bq) => (
              <span
                key={bq.query}
                className="text-xs rounded-full px-3 py-1 border border-white/30"
              >
                {(bq.query || "—").slice(0, 24)}{" "}
                <span className="opacity-70">({bq.count})</span>
              </span>
            ))}
          </div>
        </div>

        {/* Config de auditorías */}
        <div className="mt-2 space-y-2 bg-white/10 rounded-lg p-3">
          <div className="text-white/80 text-xs mb-1">Audits</div>
          <label className="text-[12px] opacity-80">Host</label>
          <input
            value={auditHost}
            onChange={(e) => setAuditHost(e.target.value)}
            placeholder="https://audit.pixelfluxcreative.com"
            className="w-full text-[12px] rounded-md border px-2 py-1 bg-white text-dark"
          />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[12px] opacity-80">Basic (days)</label>
              <input
                type="number"
                min={1}
                value={basicDays}
                onChange={(e) => setBasicDays(Number(e.target.value) || 1)}
                className="w-full text-[12px] rounded-md border px-2 py-1 bg-white text-dark"
              />
            </div>
            <div>
              <label className="text-[12px] opacity-80">Premium (days)</label>
              <input
                type="number"
                min={1}
                value={premiumDays}
                onChange={(e) => setPremiumDays(Number(e.target.value) || 1)}
                className="w-full text-[12px] rounded-md border px-2 py-1 bg-white text-dark"
              />
            </div>
          </div>
        </div>

        <a
          className="mt-auto bg-white/10 rounded px-3 py-2 text-center hover:bg-white/20"
          href="/logout"
        >
          Log out
        </a>
      </aside>

      {/* Handle cuando está colapsado (ocupa el gutter reservado) */}
      {sidebarCollapsed && (
        <button
          onClick={() => setSidebarCollapsed(false)}
          className="absolute left-2 top-6 collapse-handle bg-emerald-600 text-white hover:bg-emerald-700 z-50"
          title="Expand panel"
          aria-label="Expand panel"
        >
          ›
        </button>
      )}

      {/* Main */}
      <main className="p-6 space-y-4">
        {/* Header editable + acciones alineadas a la derecha */}
        <div className="grid grid-cols-12 gap-4 items-start">
          {/* Columna izquierda: título/estado/descripcion */}
          <div className="col-span-12 xl:col-span-7 space-y-2">
            <div className="text-xs text-slate-500">ID {camp?.id}</div>

            <input
              value={camp?.name || ""}
              onChange={(e) =>
                setCamp((c) => (c ? { ...c, name: e.target.value } : c))
              }
              onBlur={() => saveCampaign({ name: camp?.name || "" })}
              className="text-2xl font-semibold bg-transparent outline-none border-b border-transparent focus:border-emerald-300"
            />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <select
                value={camp?.status || "PLANEACION"}
                onChange={(e) =>
                  saveCampaign({ status: e.target.value as Campaign["status"] })
                }
                className="rounded-md border px-2 py-1 bg-white"
              >
                {["PLANEACION", "ACTIVA", "DETENIDA", "FINALIZADA"].map(
                  (s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s as Campaign["status"]]}
                    </option>
                  )
                )}
              </select>
              <span className="text-slate-500">
                • Created {camp ? new Date(camp.created_at).toLocaleString() : "—"}
              </span>
            </div>
            <textarea
              value={camp?.description || ""}
              onChange={(e) =>
                setCamp((c) =>
                  c ? { ...c, description: e.target.value } : c
                )
              }
              onBlur={() => saveCampaign({ description: camp?.description || null })}
              placeholder="Campaign description…"
              className="w-[680px] max-w-full rounded-md border p-2 bg-white text-sm"
              rows={2}
            />
          </div>

          {/* Columna derecha: TODAS las acciones y widgets */}
          <div className="col-span-12 xl:col-span-5 flex flex-col gap-2">
            {/* Fila 1: navegación principal */}
            <div className="flex flex-wrap justify-end gap-2">
              <Link
                href="/campaigns"
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50"
                title="Back to the campaign list"
              >
                Back
              </Link>
              <button
                onClick={deleteCampaign}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50"
              >
                Delete
              </button>
              <button
                onClick={() => setShowAdd(true)}
                disabled={camp?.status === "FINALIZADA"}
                className="rounded-md bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-sm disabled:opacity-60"
                title={
                  camp?.status === "FINALIZADA"
                    ? "Cannot add leads to a finished campaign"
                    : "Add leads"
                }
              >
                Add leads
              </button>
            </div>

            {/* Fila 2: búsqueda / utilidades */}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search within this campaign…"
                className="w-[320px] sm:w-[380px] rounded-lg border border-slate-300 p-2 text-sm bg-white"
              />
              <select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="rounded border px-2 py-1.5 text-sm bg-white"
              >
                {[50, 100, 250, 500].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button
                onClick={() => loadRows(true)}
                className="rounded border px-3 py-1.5 text-sm hover:bg-slate-50"
              >
                Refresh
              </button>
              <button
                onClick={removeSelected}
                className="rounded border px-3 py-1.5 text-sm hover:bg-slate-50"
              >
                Remove selected
              </button>
              <button
                onClick={() => generateMessages("selected")}
                disabled={!!busyMsg || selectedIds.length === 0}
                className="rounded border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
                title="Generates messages for the selected leads (requires an active basic audit + phone)"
              >
                {busyMsg === "selected"
                  ? "Generating…"
                  : "Generate messages (selected)"}
              </button>
              <button
                onClick={() => generateMessages("all")}
                disabled={!!busyMsg}
                className="rounded border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
                title="Generates messages for all leads in the campaign (requires an active basic audit + phone)"
              >
                {busyMsg === "all" ? "Generating…" : "Generate messages (all)"}
              </button>

              <button
                onClick={() => {
                  const header = [
                    "place_id",
                    "name",
                    "phone",
                    "website",
                    "audit_url",
                    "message",
                    "city",
                    "region",
                    "country",
                    "rating",
                    "reviews_count",
                    "owner_responses_count",
                  ].join(",");
                  const lines = rows.map((r) =>
                    [
                      r.place_id,
                      r.name || "",
                      r.phone || "",
                      r.website || "",
                      auditMap[r.place_id]?.basic?.url || "",
                      r.message || "",
                      r.city || "",
                      r.region || "",
                      r.country || "",
                      r.rating ?? "",
                      r.reviews_count,
                      r.owner_responses_count,
                    ]
                      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
                      .join(",")
                  );
                  const csv = [header, ...lines].join("\n");
                  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  const d = new Date();
                  const yyyy = d.getFullYear();
                  const mm = String(d.getMonth() + 1).padStart(2, "0");
                  const dd = String(d.getDate()).padStart(2, "0");
                  a.download = `campaign_${campaignId}_${yyyy}-${mm}-${dd}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="rounded border px-3 py-1.5 text-sm hover:bg-slate-50"
              >
                Export CSV
              </button>
            </div>

            {/* Fila 3: auditorías + contadores */}
            <div className="flex flex-wrap items-stretch justify-end gap-2">
              <button
                onClick={runAuditBasicForCampaign}
                disabled={!!busyAudit}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
                title="Generate a Basic audit for all leads in this campaign"
              >
                {busyAudit === "basic"
                  ? "Generating Basic…"
                  : "Basic audit (campaign)"}
              </button>
              <button
                onClick={runAuditPremiumForSelected}
                disabled={!!busyAudit || selectedIds.length === 0}
                className="rounded-md bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-sm disabled:opacity-60"
                title="Generate a Premium audit for the selected leads"
              >
                {busyAudit === "premium"
                  ? "Generating Premium…"
                  : `Premium audit (sel. ${selectedIds.length || 0})`}
              </button>

              {/* widgets contadores */}
              <div className="rounded-lg border bg-white px-3 py-2 text-center min-w-[98px]">
                <div className="text-[11px] text-slate-500">Basic</div>
                <div className="text-lg font-semibold">
                  {basicOkCount}/{totalLeadsCount}
                </div>
              </div>
              <div className="rounded-lg border bg-white px-3 py-2 text-center min-w-[98px]">
                <div className="text-[11px] text-slate-500">Premium</div>
                <div className="text-lg font-semibold">
                  {premiumOkCount}/{totalLeadsCount}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sección: Performance de auditorías básicas (funnel) */}
        <AuditsFunnel metrics={metrics} />

        {/* Tabla */}
        <div className="border rounded-lg overflow-hidden bg-white">
          <div className="max-h-[calc(90vh-220px)] overflow-y-auto">
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col className="w-[2rem]" /> {/* checkbox angosto */}
                <col className="w-[22%]" />
                <col className="w-[14ch]" />
                <col className="w-[12%]" />
                <col className="w-[18%]" />
                <col className="w-[6%]" /> {/* Mensaje */}
                <col className="w-[10%]" />
                <col className="w-[9%]" /> {/* Básica */}
                <col className="w-[7%]" /> {/* Vistas */}
                <col className="w-[7%]" /> {/* CTA ✅ */}
                <col className="w-[9%]" /> {/* Premium */}
              </colgroup>
              <thead className="bg-white sticky top-0 z-10 border-b">
                <tr className="text-left">
                  <th className="px-2">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                  </th>
                  <th className="p-2">Name</th>
                  <th className="p-2">Phone</th>
                  <th className="p-2">City</th>
                  <th className="p-2">Website</th>
                  <th className="px-2 text-center">Message</th>
                  <th className="p-2">Status</th>
                  <th className="px-2 text-center">Basic</th>
                  <th className="px-2 text-center">Views</th>
                  <th className="px-2 text-center">CTA</th>
                  <th className="px-2 text-center">Premium</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const rc = r.reviews_count || 0;
                  const oc = r.owner_responses_count || 0;
                  const badge = oc > 0 ? "✔✔" : rc > 0 ? "✔" : "—";
                  const basic = auditMap[r.place_id]?.basic;
                  const premium = auditMap[r.place_id]?.premium;
                  const basicViews = r.audit_basic_views ?? 0;

                  const ctaClicks = Number(basic?.cta_clicks ?? 0);
                  const lastCta = basic?.last_cta_click_at
                    ? new Date(basic.last_cta_click_at).toLocaleString()
                    : null;

                  return (
                    <tr key={r.place_id} className="border-t hover:bg-emerald-50/40">
                      <td className="px-2">
                        <input
                          type="checkbox"
                          checked={!!selected[r.place_id]}
                          onChange={(e) =>
                            setSelected((s) => ({
                              ...s,
                              [r.place_id]: e.target.checked,
                            }))
                          }
                        />
                      </td>
                      <td className="p-2">{r.name || "—"}</td>
                      <td className="p-2 whitespace-nowrap font-mono">
                        {r.phone || "—"}
                      </td>
                      <td className="p-2">{r.city || "—"}</td>
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
                      <td className="px-2 text-center">
                        {r.message && String(r.message).trim() ? (
                          <button
                            onClick={() => openMessageEditor(r.place_id)}
                            className="inline-flex items-center justify-center rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs font-medium hover:bg-emerald-200"
                            title="View / edit message"
                          >
                            🎫
                          </button>
                        ) : (
                          <span
                            className={
                              r.phone && String(r.phone).trim()
                                ? "inline-flex items-center justify-center rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 text-xs font-medium"
                                : "inline-flex items-center justify-center rounded-full bg-rose-100 text-rose-800 px-2 py-0.5 text-xs font-medium"
                            }
                            title={
                              r.phone && String(r.phone).trim()
                                ? "Message not generated"
                                : "No phone (cannot generate)"
                            }
                          >
                            —
                          </span>
                        )}
                      </td>
                      <td className="p-2">
                        {r.analyzed ? (
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                            Analyzed
                          </span>
                        ) : (
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">
                            New
                          </span>
                        )}{" "}
                        <span
                          className={`inline-block text-[12px] leading-none px-2 py-1 rounded-full ml-1 ${
                            oc > 0
                              ? "bg-emerald-100 text-emerald-700"
                              : rc > 0
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-slate-100 text-slate-600"
                          }`}
                          title={
                            rc > 0
                              ? `${rc} reviews · ${oc} with a response`
                              : "No reviews"
                          }
                        >
                          {badge}
                        </span>
                      </td>

                      {/* Básica */}
                      <td className="px-2 text-center">
                        {basic ? (
                          basic.status === "ACTIVE" ? (
                            <a
                              href={basic.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs font-medium hover:bg-emerald-200"
                              title="View basic audit"
                            >
                              Enabled
                            </a>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-slate-100 text-slate-700 px-2 py-0.5 text-xs font-medium">
                              Expired
                            </span>
                          )
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      {/* Vistas (Básica) */}
                      <td className="px-2 text-center">
                        {basic ? (
                          <span className="text-xs text-slate-700">
                            {basicViews}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      {/* ✅ CTA (clicks por lead) */}
                      <td className="px-2 text-center">
                        {basic ? (
                          ctaClicks > 0 ? (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-800 px-2 py-0.5 text-xs font-medium"
                              title={lastCta ? `Last click: ${lastCta}` : "CTA click"}
                            >
                              ✅ {ctaClicks}
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      {/* Premium */}
                      <td className="px-2 text-center">
                        {premium ? (
                          premium.status === "ACTIVE" ? (
                            <a
                              href={premium.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs font-medium hover:bg-emerald-200"
                              title="View premium audit"
                            >
                              Enabled
                            </a>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-slate-100 text-slate-700 px-2 py-0.5 text-xs font-medium">
                              Expired
                            </span>
                          )
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="p-6 text-center text-slate-500">
                      {loading ? "Loading…" : "No leads"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 text-right text-xs text-slate-500 border-t">
            Loaded {rows.length} of {total} · Limit {limit}
            <button
              onClick={() => loadRows(false)}
              disabled={rows.length >= total || loading}
              className="ml-3 rounded border px-3 py-1 text-xs disabled:opacity-50 hover:bg-slate-50"
            >
              Load more
            </button>
          </div>
        </div>
      </main>

      {/* Modal Agregar */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center z-50">
          <div className="bg-white w-[760px] max-w-[90vw] rounded-xl p-5 shadow-xl">
            <div className="flex items-start justify-between">
              <div className="text-lg font-semibold">Add leads to the campaign</div>
              <button
                className="text-slate-500 hover:text-slate-800"
                onClick={() => setShowAdd(false)}
              >
                ✕
              </button>
            </div>

            <div className="mt-4">
              <div className="flex gap-2 mb-3">
                <button
                  className={`px-3 py-1.5 rounded border text-sm ${
                    tabAdd === "filters" ? "bg-slate-100" : ""
                  }`}
                  onClick={() => setTabAdd("filters")}
                >
                  By filters (preview)
                </button>
                <button
                  className={`px-3 py-1.5 rounded border text-sm ${
                    tabAdd === "ids" ? "bg-slate-100" : ""
                  }`}
                  onClick={() => setTabAdd("ids")}
                >
                  Paste IDs (quick)
                </button>
              </div>

              {tabAdd === "filters" ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">Preview limit:</span>
                    <select
                      value={addLimit}
                      onChange={(e) => setAddLimit(Number(e.target.value))}
                      className="border rounded px-2 py-1 text-sm"
                    >
                      {[50, 100, 200, 500].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={refreshAddPreview}
                      className="ml-2 rounded border px-3 py-1.5 text-sm hover:bg-slate-50"
                    >
                      Refresh preview
                    </button>
                  </div>

                  <div className="text-sm text-slate-600">
                    {addPreview ? (
                      <>
                        Selection: <b>{addPreview.count}</b> (showing up to {addLimit}).
                      </>
                    ) : (
                      "No preview yet."
                    )}
                  </div>

                  <div className="border rounded p-3 h-[220px] overflow-auto bg-slate-50 text-xs">
                    <div className="font-medium mb-1">Sample of IDs</div>
                    {addPreview?.place_ids?.length ? (
                      <ul className="space-y-1">
                        {addPreview.place_ids.slice(0, 80).map((id) => (
                          <li key={id}>{id}</li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-slate-500">No data</div>
                    )}
                  </div>

                  <div className="flex justify-end">
                    <button
                      onClick={addByFilters}
                      disabled={!addPreview?.place_ids?.length}
                      className="rounded bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-sm disabled:opacity-50"
                    >
                      Add to campaign
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-sm text-slate-600">
                    Paste one or more <code>place_id</code>, one per line.
                  </div>
                  <textarea
                    value={addIdsText}
                    onChange={(e) => setAddIdsText(e.target.value)}
                    rows={8}
                    className="w-full border rounded p-2 text-sm"
                    placeholder={`ChIJN1t_tDeuEmsRUsoyG83frY4\nChIJ...`}
                  />
                  <div className="flex justify-end">
                    <button
                      onClick={addByIds}
                      className="rounded bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-sm"
                    >
                      Add to campaign
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Mensaje */}
      {msgEditOpen && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center z-50">
          <div className="bg-white w-[820px] max-w-[94vw] rounded-xl p-5 shadow-xl">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-semibold">Message</div>
                <div className="text-sm text-slate-600">
                  {msgEditName || "business"} • {msgEditPlaceId}
                </div>
              </div>
              <button
                className="text-slate-500 hover:text-slate-800"
                onClick={() => setMsgEditOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="mt-4">
              <textarea
                value={msgEditText}
                onChange={(e) => setMsgEditText(e.target.value)}
                rows={7}
                className="w-full rounded-lg border border-slate-300 p-3 text-sm font-mono"
              />
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50"
                  onClick={() => setMsgEditOpen(false)}
                  disabled={msgSaving}
                >
                  Cancel
                </button>
                <button
                  className="rounded-md bg-emerald-600 text-white px-3 py-1.5 text-sm hover:bg-emerald-700 disabled:opacity-60"
                  onClick={saveMessageEditor}
                  disabled={msgSaving}
                >
                  {msgSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Resultado Auditorías */}
      {showAuditModal && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center z-50">
          <div className="bg-white w-[820px] max-w-[94vw] rounded-xl p-5 shadow-xl">
            <div className="flex items-start justify-between">
              <div className="text-lg font-semibold">Audits</div>
              <button
                className="text-slate-500 hover:text-slate-800"
                onClick={() => !busyAudit && setShowAuditModal(false)}
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="mt-3 text-sm">
              <div className="text-slate-600">
                Host: <span className="font-mono">{auditHost}</span>
              </div>
              {busyAudit && (
                <div className="mt-2 rounded-md border px-3 py-2 bg-slate-50">
                  {busyAudit === "basic"
                    ? "Generating Basic audit for the whole campaign…"
                    : "Generating Premium audit for the selected leads…"}
                </div>
              )}

              {!busyAudit && auditResult && (
                <div className="mt-3 space-y-3">
                  {auditResult.ok ? (
                    <>
                      <div className="rounded-md border px-3 py-2 bg-emerald-50 text-emerald-900">
                        <div className="font-medium">Done!</div>
                        <div className="text-[13px]">
                          {typeof auditResult.total === "number" && (
                            <>
                              Total: <b>{auditResult.total}</b> ·{" "}
                            </>
                          )}
                          {typeof auditResult.requested === "number" && (
                            <>
                              Requested: <b>{auditResult.requested}</b> ·{" "}
                            </>
                          )}
                          Created: <b>{auditResult.created ?? 0}</b>
                          {typeof auditResult.skipped === "number" && (
                            <>
                              {" "}
                              · Skipped: <b>{auditResult.skipped}</b>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="text-sm">
                        <div className="font-medium mb-1">Link samples</div>
                        {auditResult.samples?.length ? (
                          <div className="max-h-[240px] overflow-auto border rounded bg-slate-50">
                            <table className="w-full text-xs">
                              <thead className="sticky top-0 bg-slate-100">
                                <tr>
                                  <th className="text-left p-2">place_id</th>
                                  <th className="text-left p-2">Basic</th>
                                  <th className="text-left p-2">Premium</th>
                                </tr>
                              </thead>
                              <tbody>
                                {auditResult.samples.slice(0, 50).map((s) => (
                                  <tr key={s.place_id} className="border-t">
                                    <td className="p-2 font-mono">{s.place_id}</td>
                                    <td className="p-2">
                                      {s.basic_url ? (
                                        <div className="flex items-center gap-2">
                                          <a
                                            href={s.basic_url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-emerald-700 underline truncate"
                                            title={s.basic_url}
                                          >
                                            {s.basic_url}
                                          </a>
                                          <button
                                            onClick={async () => {
                                              try {
                                                await navigator.clipboard.writeText(
                                                  s.basic_url!
                                                );
                                              } catch (e) {
                                                console.error(e);
                                              }
                                            }}
                                            className="text-[11px] rounded border px-2 py-0.5 hover:bg-white"
                                          >
                                            Copy
                                          </button>
                                        </div>
                                      ) : (
                                        <span className="text-slate-400">—</span>
                                      )}
                                    </td>
                                    <td className="p-2">
                                      {s.premium_url ? (
                                        <div className="flex items-center gap-2">
                                          <a
                                            href={s.premium_url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-emerald-700 underline truncate"
                                            title={s.premium_url}
                                          >
                                            {s.premium_url}
                                          </a>
                                          <button
                                            onClick={async () => {
                                              try {
                                                await navigator.clipboard.writeText(
                                                  s.premium_url!
                                                );
                                              } catch (e) {
                                                console.error(e);
                                              }
                                            }}
                                            className="text-[11px] rounded border px-2 py-0.5 hover:bg-white"
                                          >
                                            Copy
                                          </button>
                                        </div>
                                      ) : (
                                        <span className="text-slate-400">—</span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="text-slate-500">
                            The backend didn't return any samples. Check the summary.
                          </div>
                        )}
                      </div>

                      <div className="text-xs text-slate-500">
                        * Remember: Basic expires in {basicDays} day(s) and Premium in{" "}
                        {premiumDays} day(s), based on your settings.
                      </div>
                    </>
                  ) : (
                    <div className="rounded-md border px-3 py-2 bg-rose-50 text-rose-900">
                      <div className="font-medium">Error generating audits</div>
                      <div className="text-[13px] break-words">
                        {auditResult.error || "Check the backend or network."}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowAuditModal(false)}
                disabled={!!busyAudit}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Funnel de auditorías básicas: enviadas → vistas → clics CTA
 * Usa el bloque metrics.audits_basic que viene del backend.
 */
function AuditsFunnel({ metrics }: { metrics: Metrics | null }) {
  const m = metrics?.audits_basic;
  const sent = m?.sent_count ?? 0;
  const viewed = m?.viewed_count ?? 0;
  const clicks = m?.cta_clicks ?? 0;

  const viewRate =
    sent > 0
      ? Math.round(
          100 *
            (m?.view_rate != null && !Number.isNaN(m.view_rate)
              ? m.view_rate
              : viewed / sent || 0)
        )
      : 0;

  const clickRate =
    viewed > 0
      ? Math.round(
          100 *
            (m?.cta_click_rate != null && !Number.isNaN(m.cta_click_rate)
              ? m.cta_click_rate
              : clicks / viewed || 0)
        )
      : 0;

  const hasAny = sent > 0 || viewed > 0 || clicks > 0;

  return (
    <section className="border rounded-lg bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-sm">
          Basic audits performance
        </div>
        <div className="text-xs text-slate-500">
          Funnel: sent → viewed → CTA clicks
        </div>
      </div>

      {!metrics || !m || !hasAny ? (
        <div className="text-xs text-slate-500">
          No metrics yet for this campaign's Basic audits.
          Generate basic links and, once leads open them and click the CTA,
          you'll see the full funnel here.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm text-center">
            <div className="rounded-md border bg-slate-50 px-3 py-2">
              <div className="text-[11px] text-slate-500 mb-1">Sent</div>
              <div className="text-lg font-semibold">{sent}</div>
              <div className="text-[11px] text-slate-500 mt-1">
                Basic audits created
              </div>
            </div>
            <div className="rounded-md border bg-slate-50 px-3 py-2">
              <div className="text-[11px] text-slate-500 mb-1">Viewed</div>
              <div className="text-lg font-semibold">{viewed}</div>
              <div className="text-[11px] text-slate-500 mt-1">
                {viewRate}% of those sent
              </div>
            </div>
            <div className="rounded-md border bg-slate-50 px-3 py-2">
              <div className="text-[11px] text-slate-500 mb-1">CTA clicks</div>
              <div className="text-lg font-semibold">{clicks}</div>
              <div className="text-[11px] text-slate-500 mt-1">
                {clickRate}% of those who viewed it
              </div>
            </div>
          </div>

          <div className="text-[11px] text-slate-600">
            Of <b>{sent}</b> basic audits sent,{" "}
            <b>{viewed}</b> have been viewed ({viewRate}% open rate) and{" "}
            <b>{clicks}</b> leads clicked the CTA (
            {clickRate}% of those who viewed it).
          </div>
        </>
      )}
    </section>
  );
}


