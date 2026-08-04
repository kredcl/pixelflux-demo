// web/app/campaigns/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type CampaignStatus = "PLANEACION" | "ACTIVA" | "DETENIDA" | "FINALIZADA";

type CtaBasicVariant = "whatsapp_premium" | "calendar" | "whatsapp_direct";

type AuditsBasicMetrics = {
  sent_count: number;
  viewed_count: number;
  view_rate: number; // 0–1
  cta_clicks: number;
  cta_click_rate: number; // 0–1
};

type Campaign = {
  id: number;
  name: string;
  status: CampaignStatus;
  description?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  leads_count: number;
  cta_basic_variant?: CtaBasicVariant | null;
  // Bloque de métricas de auditorías básicas
  audits_basic?: AuditsBasicMetrics | null;
};

type Metrics = {
  [key in CampaignStatus]?: number;
};

type AuditKind = "BASIC" | "PREMIUM";

type LinkRow = {
  audit_id: number;
  place_id: string;
  kind: AuditKind;
  expires_at: string;
  views: number;
  url: string;
  status: "ACTIVE" | "EXPIRED";
};

type CampaignLeadRow = {
  place_id: string;
  name: string;
  city?: string | null;
  website?: string | null;
};

// Dashboard agregado de campañas (ver CONTEXT_MAP.md §6.6/§6.4)
type FunnelStats = {
  sent_count: number;
  viewed_count: number;
  cta_clicks: number;
  view_rate: number;
  cta_click_rate: number;
};

type CtaBreakdown = {
  total: number;
  opened: number;
  clicked: number;
  open_rate: number;
  click_rate: number;
};

type CampaignPerf = {
  id: number;
  name: string;
  status: CampaignStatus;
  leads_count: number;
  basic: FunnelStats;
  premium: FunnelStats;
};

type CampaignsDashboardData = {
  by_status: Record<CampaignStatus, number>;
  total_campaigns: number;
  total_leads_assigned: number;
  funnel: { BASIC: FunnelStats; PREMIUM: FunnelStats };
  by_cta: Record<string, CtaBreakdown>;
  campaigns: CampaignPerf[];
};

const API =
  (process.env.NEXT_PUBLIC_API_BASE_URL as string) ||
  (process.env.NEXT_PUBLIC_API_BASE as string) ||
  "https://api.pixelfluxcreative.com";

// Display labels for campaign status codes (the codes themselves stay as the
// backend's literal values; only what's shown to the user is translated).
const STATUS_LABELS: Record<CampaignStatus | "TODAS", string> = {
  TODAS: "All",
  PLANEACION: "Planning",
  ACTIVA: "Active",
  DETENIDA: "Stopped",
  FINALIZADA: "Finished",
};

export default function CampaignsPage() {
  // auth (igual que otras vistas)
  const [me, setMe] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // UI: panel plegable
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);

  // === Dashboard agregado (tab nuevo, ver CONTEXT_MAP.md §6.6/§6.4) ===
  const [activeTab, setActiveTab] = useState<"catalog" | "dashboard">("catalog");
  const [dashboardData, setDashboardData] = useState<CampaignsDashboardData | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardErr, setDashboardErr] = useState<string | null>(null);
  const [dashboardLoadedOnce, setDashboardLoadedOnce] = useState(false);
  // Puente hacia el dashboard de leads: reusa el mismo total que expone
  // GET /leads/dashboard/ranking en vez de duplicar esa tabla acá.
  const [highPriorityUnassigned, setHighPriorityUnassigned] = useState<number | null>(null);

  const loadCampaignsDashboard = async () => {
    setDashboardLoading(true);
    setDashboardErr(null);
    try {
      const [dashRes, rankRes] = await Promise.all([
        fetch(`${API}/campaigns/dashboard`, { credentials: "include", cache: "no-store" }),
        fetch(`${API}/leads/dashboard/ranking?offset=0&limit=1`, { credentials: "include", cache: "no-store" }),
      ]);
      if (!dashRes.ok) throw new Error(`HTTP ${dashRes.status}`);
      setDashboardData(await dashRes.json());
      if (rankRes.ok) {
        const rd = await rankRes.json();
        setHighPriorityUnassigned(typeof rd.total === "number" ? rd.total : null);
      }
    } catch (e: any) {
      setDashboardErr(String(e?.message || e));
    } finally {
      setDashboardLoading(false);
    }
  };

  const openDashboardTab = () => {
    setActiveTab("dashboard");
    if (!dashboardLoadedOnce) {
      setDashboardLoadedOnce(true);
      loadCampaignsDashboard();
    }
  };

  // datos
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [rows, setRows] = useState<Campaign[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);

  // filtros
  const [statusFilter, setStatusFilter] = useState<CampaignStatus | "TODAS">(
    "TODAS"
  );
  const [search, setSearch] = useState("");

  // crear campaña
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newCtaBasic, setNewCtaBasic] =
    useState<CtaBasicVariant>("whatsapp_premium");
  const [creating, setCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // --- Gestión de auditorías (modal) ---
  const [auditModalOpen, setAuditModalOpen] = useState(false);
  const [auditModalTab, setAuditModalTab] = useState<AuditKind>("BASIC");
  const [auditCampId, setAuditCampId] = useState<number | null>(null);
  const [auditCampName, setAuditCampName] = useState<string>("");

  const [linksBasic, setLinksBasic] = useState<LinkRow[]>([]);
  const [linksPremium, setLinksPremium] = useState<LinkRow[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [linksMsg, setLinksMsg] = useState<string | null>(null);

  const [leadsList, setLeadsList] = useState<CampaignLeadRow[]>([]);
  const [loadingLeads, setLoadingLeads] = useState(false);
  const [selectedLeads, setSelectedLeads] = useState<Set<string>>(new Set());
  const [leadsSearch, setLeadsSearch] = useState("");

  // persistencia del plegado
  useEffect(() => {
    try {
      const v = localStorage.getItem("px_campaigns_sidebar_collapsed");
      if (v === "1") setSidebarCollapsed(true);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        "px_campaigns_sidebar_collapsed",
        sidebarCollapsed ? "1" : "0"
      );
    } catch {}
  }, [sidebarCollapsed]);

  // auth
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/me`, { credentials: "include" });
        if (!r.ok) throw new Error("auth");
        const d = await r.json();
        setMe(d);
      } catch {
        setMe(null);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!authLoading && !me) {
      window.location.href = "/login";
    }
  }, [authLoading, me]);

  // cargar métricas y campañas
  const loadMetrics = async () => {
    try {
      const r = await fetch(`${API}/campaigns/metrics`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) return;
      const d = await r.json();
      setMetrics(d);
    } catch {}
  };

  const loadRows = async () => {
    setLoadingRows(true);
    try {
      const params = new URLSearchParams({ offset: "0", limit: "500" });
      if (statusFilter !== "TODAS") params.set("status", statusFilter);
      const r = await fetch(`${API}/campaigns?` + params.toString(), {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) return;
      const list = (await r.json()) as Campaign[];
      setRows(list);
    } finally {
      setLoadingRows(false);
    }
  };

  useEffect(() => {
    loadMetrics();
  }, []);
  useEffect(() => {
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.description || "").toLowerCase().includes(q) ||
        String(c.id).includes(q)
    );
  }, [rows, search]);

  const formatDate = (s?: string | null) => {
    if (!s) return "—";
    try {
      const d = new Date(s);
      if (isNaN(d.getTime())) return "—";
      return d.toLocaleString();
    } catch {
      return "—";
    }
  };

  const createCampaign = async () => {
    setErrorMsg(null);
    const name = newName.trim();
    if (!name) {
      setErrorMsg("Name is required.");
      return;
    }
    setCreating(true);
    try {
      const r = await fetch(`${API}/campaigns`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: newDesc.trim() || null,
          cta_basic_variant: newCtaBasic,
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `HTTP ${r.status}`);
      }
      // refrescar lista y métricas
      await Promise.all([loadRows(), loadMetrics()]);
      // limpiar modal
      setShowCreate(false);
      setNewName("");
      setNewDesc("");
      setNewCtaBasic("whatsapp_premium");
    } catch (e: any) {
      setErrorMsg((e as any)?.message || "Error creating campaign");
    } finally {
      setCreating(false);
    }
  };

  // -------- Helpers Auditorías --------
  const copyToClipboard = async (t: string) => {
    try {
      await navigator.clipboard.writeText(t);
      setLinksMsg("Link copied to clipboard");
      setTimeout(() => setLinksMsg(null), 1500);
    } catch {
      alert("Could not copy the link.");
    }
  };

  const loadLinks = async (campaignId: number) => {
    setLoadingLinks(true);
    try {
      const [b, p] = await Promise.all([
        fetch(`${API}/audits/campaign/${campaignId}/links?kind=BASIC`, {
          credentials: "include",
          cache: "no-store",
        }).then((r) => (r.ok ? r.json() : { items: [] })),
        fetch(`${API}/audits/campaign/${campaignId}/links?kind=PREMIUM`, {
          credentials: "include",
          cache: "no-store",
        }).then((r) => (r.ok ? r.json() : { items: [] })),
      ]);
      setLinksBasic((b.items || []) as LinkRow[]);
      setLinksPremium((p.items || []) as LinkRow[]);
    } finally {
      setLoadingLinks(false);
    }
  };

  const loadCampaignLeads = async (campaignId: number) => {
    setLoadingLeads(true);
    try {
      const r = await fetch(`${API}/campaigns/${campaignId}/leads`, {
        credentials: "include",
        cache: "no-store",
      });

      if (!r.ok) {
        setLeadsList([]);
        return;
      }

      const d = await r.json();

      // El backend devuelve { items: [...], offset, limit }
      // pero dejamos compatibilidad si alguna vez devuelve un array plano.
      const items: CampaignLeadRow[] = Array.isArray(d)
        ? d
        : Array.isArray((d as any)?.items)
        ? (d as any).items
        : [];

      setLeadsList(items);
      setSelectedLeads(new Set()); // reset selección
    } finally {
      setLoadingLeads(false);
    }
  };

  const openAuditManager = async (c: Campaign) => {
    setAuditCampId(c.id);
    setAuditCampName(c.name);
    setAuditModalTab("BASIC");
    setLinksMsg(null);
    await Promise.all([loadLinks(c.id), loadCampaignLeads(c.id)]);
    setAuditModalOpen(true);
  };

  const closeAuditManager = () => {
    setAuditModalOpen(false);
    setLinksMsg(null);
    setLinksBasic([]);
    setLinksPremium([]);
    setLeadsList([]);
    setSelectedLeads(new Set());
  };

  const genBasicForCampaign = async () => {
    if (!auditCampId) return;
    setLinksMsg(null);
    const res = await fetch(`${API}/audits/campaign/${auditCampId}/basic`, {
      method: "POST",
      credentials: "include",
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      setLinksMsg(
        `Basic: created ${d.created ?? 0}, skipped ${d.skipped ?? 0}`
      );
      await loadLinks(auditCampId);
      // recargar campañas para que se actualicen las métricas de funnel
      await loadRows();
    } else {
      alert("Could not generate the basic audits.");
    }
  };

  const genPremiumSelected = async () => {
    if (!auditCampId) return;
    const place_ids = Array.from(selectedLeads);
    if (!place_ids.length)
      return alert("Select at least one lead from the campaign.");
    setLinksMsg(null);
    const res = await fetch(`${API}/audits/campaign/${auditCampId}/premium`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(place_ids),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      setLinksMsg(
        `Premium: created ${d.created ?? 0}, skipped ${d.skipped ?? 0}`
      );
      await loadLinks(auditCampId);
    } else {
      alert("Could not generate the premium audits.");
    }
  };

  const renewLink = async (auditId: number, kind: AuditKind) => {
    const days = kind === "BASIC" ? 7 : 10;
    const r = await fetch(
      `${API}/audits/${auditId}/renew?days_valid=${days}`,
      { method: "POST", credentials: "include" }
    );
    if (!r.ok) {
      alert("Could not renew.");
      return;
    }
    if (auditCampId) await loadLinks(auditCampId);
  };

  const revokeLink = async (auditId: number) => {
    const r = await fetch(`${API}/audits/${auditId}/revoke`, {
      method: "POST",
      credentials: "include",
    });
    if (!r.ok) {
      alert("Could not revoke.");
      return;
    }
    if (auditCampId) await loadLinks(auditCampId);
  };

  // --- Filtros en leads del modal premium
  const filteredLeads = useMemo(() => {
    // Nos aseguramos de trabajar siempre con un array
    const base: CampaignLeadRow[] = Array.isArray(leadsList) ? leadsList : [];

    const s = leadsSearch.trim().toLowerCase();
    if (!s) return base;

    return base.filter((l) =>
      [l.place_id, l.name, l.city, l.website]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase())
        .some((v) => v.includes(s))
    );
  }, [leadsList, leadsSearch]);

  const toggleLead = (pid: string) => {
    setSelectedLeads((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    const allSelected = filteredLeads.every((l) =>
      selectedLeads.has(l.place_id)
    );

    setSelectedLeads((prev) => {
      const next = new Set(prev);

      if (allSelected) {
        // deseleccionar todos los filtrados
        filteredLeads.forEach((l) => next.delete(l.place_id));
      } else {
        // seleccionar todos los filtrados
        filteredLeads.forEach((l) => next.add(l.place_id));
      }

      return next;
    });
  };

  if (authLoading || !me) {
    return <main className="p-8">Loading…</main>;
  }

  return (
    <div
      className="min-h-screen bg-[#f2f8f6] text-slate-900 grid relative g-cols-smooth"
      style={{ gridTemplateColumns: `${sidebarCollapsed ? "24px" : "280px"} 1fr` }}
    >
      {/* Sidebar */}
      <aside
        className={`bg-dark text-white p-6 flex flex-col gap-4 relative overflow-hidden opacity-smooth ${
          sidebarCollapsed ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
        aria-hidden={sidebarCollapsed}
      >
        <div className="text-xl font-semibold">Campaigns</div>

        {/* Handle (visible cuando está abierto) */}
        <button
          onClick={() => setSidebarCollapsed(true)}
          className="absolute -right-3 top-6 collapse-handle bg-emerald-600 text-white hover:bg-emerald-700"
          title="Collapse panel"
          aria-label="Collapse panel"
        >
          ‹
        </button>

        <Link
          href="/panel"
          className="bg-white/10 rounded px-3 py-2 text-center hover:bg-white/20"
        >
          Back
        </Link>
        <Link
          href="/leads"
          className="bg-white/10 rounded px-3 py-2 text-center hover:bg-white/20"
        >
          Go to Leads
        </Link>

        {/* Métricas por estado */}
        <div className="space-y-2 text-sm">
          <div className="bg-white/10 rounded-lg p-3">
            <div className="text-white/80 text-xs">{STATUS_LABELS.PLANEACION}</div>
            <div className="text-xl font-semibold">
              {metrics?.PLANEACION ?? 0}
            </div>
          </div>
          <div className="bg-white/10 rounded-lg p-3">
            <div className="text-white/80 text-xs">{STATUS_LABELS.ACTIVA}</div>
            <div className="text-xl font-semibold">{metrics?.ACTIVA ?? 0}</div>
          </div>
          <div className="bg-white/10 rounded-lg p-3">
            <div className="text-white/80 text-xs">{STATUS_LABELS.DETENIDA}</div>
            <div className="text-xl font-semibold">
              {metrics?.DETENIDA ?? 0}
            </div>
          </div>
          <div className="bg-white/10 rounded-lg p-3">
            <div className="text-white/80 text-xs">{STATUS_LABELS.FINALIZADA}</div>
            <div className="text-xl font-semibold">
              {metrics?.FINALIZADA ?? 0}
            </div>
          </div>
        </div>

        {/* Filtros rápidos por estado */}
        <div className="space-y-2">
          <div className="text-sm opacity-80">Filter status</div>
          <div className="grid grid-cols-2 gap-2">
            {(
              ["TODAS", "PLANEACION", "ACTIVA", "DETENIDA", "FINALIZADA"] as const
            ).map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`rounded-lg px-3 py-2 text-left bg-white/10 hover:bg-white/20 text-sm ${
                  statusFilter === st ? "ring-2 ring-emerald-400" : ""
                }`}
              >
                {STATUS_LABELS[st]}
              </button>
            ))}
          </div>
        </div>

        <a
          className="mt-auto bg-white/10 rounded px-3 py-2 text-center hover:bg-white/20"
          href="/logout"
        >
          Log out
        </a>
      </aside>

      {/* Handle (visible cuando está colapsado) */}
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
        {/* Tabs: Catálogo (listado + gestión) vs Dashboard (resumen agregado) */}
        <div className="flex rounded-lg border overflow-hidden w-fit">
          <button
            onClick={() => setActiveTab("catalog")}
            className={`px-4 py-2 text-sm font-medium ${activeTab === "catalog" ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"
              }`}
          >
            Catalog
          </button>
          <button
            onClick={openDashboardTab}
            className={`px-4 py-2 text-sm font-medium ${activeTab === "dashboard" ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"
              }`}
          >
            Dashboard
          </button>
        </div>

        {activeTab === "dashboard" && (
          <CampaignsDashboardView
            data={dashboardData}
            loading={dashboardLoading}
            err={dashboardErr}
            onRefresh={loadCampaignsDashboard}
            highPriorityUnassigned={highPriorityUnassigned}
          />
        )}

        {activeTab === "catalog" && (
        <>
        {/* Nota explicativa del flujo de outreach (demo) */}
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-3 text-sm">
          Templates and conversations below show what the outreach flow looks
          like end to end — always initiated and reviewed by a human, never
          fully automated. Message delivery here is simulated for the demo;
          in production it runs through WhatsApp's Business API.
        </div>

        {/* Acciones superiores */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void 0}
            placeholder="Search campaign (name, description, ID)…"
            className="w-96 rounded-lg border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white"
          />
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-sm"
            title="Create a new campaign"
          >
            New campaign
          </button>
          <button
            onClick={() => {
              setSearch("");
              setStatusFilter("TODAS");
              loadMetrics();
              loadRows();
            }}
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50"
          >
            Clear
          </button>
        </div>

        {/* Tabla */}
        <div className="border rounded-lg overflow-hidden bg-white">
          <div className="max-h-[calc(90vh-140px)] overflow-y-auto">
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col className="w-[28%]" />
                <col className="w-[12ch]" />
                <col className="w-[10ch]" />
                <col className="w-[18ch]" />
                <col className="w-[1fr]" />
                <col className="w-[26ch]" /> {/* Auditorías + funnel */}
              </colgroup>
              <thead className="bg-white sticky top-0 z-10 border-b">
                <tr className="text-left">
                  <th className="p-2">Name</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Leads</th>
                  <th className="p-2">Created</th>
                  <th className="p-2">Description</th>
                  <th className="p-2">Audits</th>
                </tr>
              </thead>

              <tbody>
                {loadingRows ? (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-slate-500">
                      Loading…
                    </td>
                  </tr>
                ) : filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-slate-500">
                      No results
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((c) => (
                    <tr key={c.id} className="border-t hover:bg-emerald-50/40">
                      <td className="p-2">
                        {/* 👇 Nombre clickeable hacia /campaigns/[id] */}
                        <Link
                          href={`/campaigns/${c.id}`}
                          className="font-medium text-emerald-700 underline hover:no-underline"
                          title={`Go to campaign ${c.name}`}
                        >
                          {c.name}
                        </Link>
                        <div className="text-[12px] text-slate-500">
                          ID {c.id}
                        </div>
                      </td>
                      <td className="p-2">
                        <StatusBadge status={c.status} />
                      </td>
                      <td className="p-2">{c.leads_count ?? 0}</td>
                      <td className="p-2">{formatDate(c.created_at)}</td>
                      <td className="p-2">
                        <div className="truncate" title={c.description || ""}>
                          {c.description || "—"}
                        </div>
                      </td>
                      <td className="p-2">
                        <div className="flex flex-col gap-1">
                          <AuditsBasicSummary campaign={c} />
                          <div className="flex flex-wrap gap-2">
                            <button
                              className="rounded border px-2 py-1 text-xs hover:bg-slate-50"
                              onClick={() => openAuditManager(c)}
                              title="Manage audits (links, generate, renew, revoke)"
                            >
                              Manage
                            </button>
                            <button
                              className="rounded border px-2 py-1 text-xs hover:bg-slate-50"
                              onClick={async () => {
                                await openAuditManager(c);
                                setAuditModalTab("BASIC");
                                genBasicForCampaign();
                              }}
                              title="Generate Basic (all leads in the campaign)"
                            >
                              Generate Basic
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 text-right text-xs text-slate-500 border-t">
            Total {filteredRows.length} campaign(s)
          </div>
        </div>
        </>
        )}
      </main>

      {/* Modal: Crear campaña */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center z-50">
          <div className="bg-white w-[560px] max-w-[92vw] rounded-xl p-5 shadow-xl">
            <div className="flex items-start justify-between">
              <div className="text-lg font-semibold">New campaign</div>
              <button
                className="text-slate-500 hover:text-slate-800"
                onClick={() => !creating && setShowCreate(false)}
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <label className="block">
                <div className="text-sm text-slate-700 mb-1">Name</div>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full rounded-lg border p-2 text-sm"
                  placeholder="E.g.: Q4 Downtown Restaurants"
                />
              </label>

              <label className="block">
                <div className="text-sm text-slate-700 mb-1">
                  Description (optional)
                </div>
                <textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  className="w-full rounded-lg border p-2 text-sm"
                  rows={3}
                  placeholder="Goal, segment, notes…"
                />
              </label>

              <div className="block">
                <div className="text-sm text-slate-700 mb-1">
                  CTA for Basic audits
                </div>
                <div className="flex flex-wrap gap-2">
                  {[
                    { value: "whatsapp_premium", label: "WhatsApp Premium" },
                    { value: "calendar", label: "Calendar" },
                    { value: "whatsapp_direct", label: "Direct WhatsApp" },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        setNewCtaBasic(opt.value as CtaBasicVariant)
                      }
                      className={
                        "rounded-full border px-3 py-1 text-xs " +
                        (newCtaBasic === opt.value
                          ? "bg-emerald-600 border-emerald-600 text-white"
                          : "border-slate-300 text-slate-700 hover:bg-slate-50")
                      }
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  This CTA will be used for all Basic links you generate
                  for this campaign.
                </div>
              </div>

              {errorMsg && (
                <div className="text-sm text-rose-600">{errorMsg}</div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setShowCreate(false)}
                  disabled={creating}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  onClick={createCampaign}
                  disabled={creating}
                  className="rounded-md bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-sm disabled:opacity-60"
                >
                  {creating ? "Creating…" : "Create campaign"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Gestión de Auditorías */}
      {auditModalOpen && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center z-50">
          <div className="bg-white w-[980px] max-w-[96vw] rounded-xl p-5 shadow-xl">
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="text-lg font-semibold">
                  Campaign audits
                </div>
                <div className="text-sm text-slate-600">
                  Campaign: <b>{auditCampName}</b> (ID {auditCampId})
                </div>
              </div>
              <button
                className="text-slate-500 hover:text-slate-800"
                onClick={closeAuditManager}
                title="Close"
              >
                ✕
              </button>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-2 mb-3">
              <button
                className={`px-3 py-1.5 rounded border text-sm ${
                  auditModalTab === "BASIC"
                    ? "bg-slate-900 text-white"
                    : "bg-white hover:bg-slate-50"
                }`}
                onClick={() => setAuditModalTab("BASIC")}
              >
                Basic
              </button>
              <button
                className={`px-3 py-1.5 rounded border text-sm ${
                  auditModalTab === "PREMIUM"
                    ? "bg-slate-900 text-white"
                    : "bg-white hover:bg-slate-50"
                }`}
                onClick={() => setAuditModalTab("PREMIUM")}
              >
                Premium
              </button>
              {linksMsg && (
                <div className="ml-auto text-xs text-emerald-700">
                  {linksMsg}
                </div>
              )}
            </div>

            {auditModalTab === "BASIC" ? (
              <section className="space-y-3">
                <div className="rounded border p-3 flex items-center justify-between">
                  <div>
                    <div className="font-medium">Generate Basic links</div>
                    <div className="text-sm text-slate-600">
                      Creates a basic link for each lead in the campaign. Valid
                      for 7 days.
                    </div>
                  </div>
                  <button
                    onClick={genBasicForCampaign}
                    className="rounded bg-emerald-600 text-white px-3 py-1.5 text-sm"
                  >
                    Generate (all)
                  </button>
                </div>

                <LinksTable
                  title="Generated Basic links"
                  items={linksBasic}
                  loading={loadingLinks}
                  onCopy={copyToClipboard}
                  onRenew={(id) => renewLink(id, "BASIC")}
                  onRevoke={revokeLink}
                />
              </section>
            ) : (
              <section className="space-y-4">
                <div className="rounded border">
                  <div className="p-3 border-b flex items-center gap-2">
                    <div className="font-medium">Select leads for Premium</div>
                    <div className="ml-auto flex items-center gap-2">
                      <input
                        className="border rounded px-2 py-1 text-sm w-64"
                        placeholder="Search lead (name, city, website, place_id)"
                        value={leadsSearch}
                        onChange={(e) => setLeadsSearch(e.target.value)}
                      />
                      <button
                        onClick={toggleAllFiltered}
                        className="rounded border px-2 py-1 text-xs hover:bg-slate-50"
                      >
                        {filteredLeads.every((l) =>
                          selectedLeads.has(l.place_id)
                        )
                          ? "Deselect filtered"
                          : "Select filtered"}
                      </button>
                      <button
                        onClick={genPremiumSelected}
                        className="rounded bg-indigo-600 text-white px-3 py-1.5 text-sm"
                        disabled={selectedLeads.size === 0}
                      >
                        Generate Premium ({selectedLeads.size})
                      </button>
                    </div>
                  </div>

                  <div className="max-h-[40vh] overflow-y-auto p-2">
                    {loadingLeads ? (
                      <div className="p-3 text-slate-500 text-sm">
                        Loading leads…
                      </div>
                    ) : filteredLeads.length === 0 ? (
                      <div className="p-3 text-slate-500 text-sm">
                        No leads to show.
                      </div>
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-white border-b">
                          <tr className="text-left">
                            <th className="p-2 w-[3ch]">Sel</th>
                            <th className="p-2 w-[28%]">Name</th>
                            <th className="p-2 w-[18%]">City</th>
                            <th className="p-2 w-[28%]">Website</th>
                            <th className="p-2">place_id</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredLeads.map((l) => (
                            <tr key={l.place_id} className="border-t">
                              <td className="p-2">
                                <input
                                  type="checkbox"
                                  checked={selectedLeads.has(l.place_id)}
                                  onChange={() => toggleLead(l.place_id)}
                                />
                              </td>
                              <td className="p-2">{l.name || "—"}</td>
                              <td className="p-2">{l.city || "—"}</td>
                              <td className="p-2">
                                {l.website ? (
                                  <a
                                    className="text-emerald-700 underline"
                                    href={l.website}
                                    target="_blank"
                                  >
                                    {l.website.replace(/^https?:\/\//, "")}
                                  </a>
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td className="p-2 font-mono text-xs">
                                {l.place_id}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

                <LinksTable
                  title="Generated Premium links"
                  items={linksPremium}
                  loading={loadingLinks}
                  onCopy={copyToClipboard}
                  onRenew={(id) => renewLink(id, "PREMIUM")}
                  onRevoke={revokeLink}
                />
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function pct(n: number): string {
  return `${Math.round((n || 0) * 100)}%`;
}

function FunnelCard({ title, stats }: { title: string; stats: FunnelStats }) {
  return (
    <div className="border rounded-lg bg-white p-4">
      <div className="text-xs text-slate-500 mb-2">{title}</div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-xl font-semibold">{stats.sent_count}</div>
          <div className="text-[11px] text-slate-500">Sent</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-emerald-700">{stats.viewed_count}</div>
          <div className="text-[11px] text-slate-500">Viewed ({pct(stats.view_rate)})</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-indigo-700">{stats.cta_clicks}</div>
          <div className="text-[11px] text-slate-500">CTA clicks ({pct(stats.cta_click_rate)})</div>
        </div>
      </div>
    </div>
  );
}

const ctaLabelMap: Record<string, string> = {
  whatsapp_premium: "WhatsApp Premium",
  calendar: "Calendar",
  whatsapp_direct: "Direct WhatsApp",
};

function CampaignsDashboardView({
  data,
  loading,
  err,
  onRefresh,
  highPriorityUnassigned,
}: {
  data: CampaignsDashboardData | null;
  loading: boolean;
  err: string | null;
  onRefresh: () => void;
  highPriorityUnassigned: number | null;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          {loading ? (
            <span className="text-slate-500">Loading summary…</span>
          ) : err ? (
            <span className="text-rose-600">{err}</span>
          ) : null}
        </div>
        <button onClick={onRefresh} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50">
          Refresh
        </button>
      </div>

      {/* Totales generales */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="border rounded-lg bg-white p-4">
          <div className="text-xs text-slate-500">Total campaigns</div>
          <div className="text-2xl font-semibold">{data?.total_campaigns ?? "—"}</div>
          <div className="text-[11px] text-slate-500 mt-1">
            Planning {data?.by_status?.PLANEACION ?? 0} · Active {data?.by_status?.ACTIVA ?? 0} · Stopped{" "}
            {data?.by_status?.DETENIDA ?? 0} · Finished {data?.by_status?.FINALIZADA ?? 0}
          </div>
        </div>
        <div className="border rounded-lg bg-white p-4">
          <div className="text-xs text-slate-500">Leads assigned to campaigns</div>
          <div className="text-2xl font-semibold">{data?.total_leads_assigned ?? "—"}</div>
        </div>
        {/* Puente hacia el dashboard de leads -- NO duplica el ranking, solo linkea */}
        <Link
          href="/leads"
          className="border rounded-lg bg-white p-4 hover:bg-emerald-50/40 block"
          title="View the full ranking in the Leads Dashboard"
        >
          <div className="text-xs text-slate-500">High priority, unassigned</div>
          <div className="text-2xl font-semibold text-amber-700">{highPriorityUnassigned ?? "—"}</div>
          <div className="text-[11px] text-emerald-700 mt-1 underline">View in Leads Dashboard →</div>
        </Link>
      </div>

      {/* Funnel agregado BASIC + PREMIUM */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <FunnelCard title="Aggregate funnel — Basic Audits" stats={data?.funnel.BASIC ?? { sent_count: 0, viewed_count: 0, cta_clicks: 0, view_rate: 0, cta_click_rate: 0 }} />
        <FunnelCard title="Aggregate funnel — Premium Audits" stats={data?.funnel.PREMIUM ?? { sent_count: 0, viewed_count: 0, cta_clicks: 0, view_rate: 0, cta_click_rate: 0 }} />
      </div>

      {/* Desglose por CTA (solo Básicas) */}
      <div className="border rounded-lg bg-white overflow-hidden">
        <div className="px-4 py-2 border-b font-medium text-sm">
          Comparison by CTA variant (Basic, all campaigns)
        </div>
        <table className="w-full text-sm">
          <thead className="bg-white border-b">
            <tr className="text-left">
              <th className="p-2">CTA</th>
              <th className="p-2 text-right">Sent</th>
              <th className="p-2 text-right">Viewed</th>
              <th className="p-2 text-right">Open rate</th>
              <th className="p-2 text-right">Clicks</th>
              <th className="p-2 text-right">Click rate</th>
            </tr>
          </thead>
          <tbody>
            {!data || Object.keys(data.by_cta).length === 0 ? (
              <tr>
                <td colSpan={6} className="p-4 text-center text-slate-500">
                  {loading ? "Loading…" : "No data yet"}
                </td>
              </tr>
            ) : (
              Object.entries(data.by_cta).map(([key, d]) => (
                <tr key={key} className="border-t">
                  <td className="p-2">{ctaLabelMap[key] || key}</td>
                  <td className="p-2 text-right">{d.total}</td>
                  <td className="p-2 text-right">{d.opened}</td>
                  <td className="p-2 text-right">{pct(d.open_rate)}</td>
                  <td className="p-2 text-right">{d.clicked}</td>
                  <td className="p-2 text-right">{pct(d.click_rate)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Tabla por campaña */}
      <div className="border rounded-lg bg-white overflow-hidden">
        <div className="px-4 py-2 border-b font-medium text-sm">Performance by campaign</div>
        <div className="max-h-[480px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-white sticky top-0 border-b">
              <tr className="text-left">
                <th className="p-2">Name</th>
                <th className="p-2">Status</th>
                <th className="p-2 text-right">Leads</th>
                <th className="p-2 text-right" title="Basic: sent / viewed / clicked">
                  Basic (sent/viewed/clicked)
                </th>
                <th className="p-2 text-right" title="Premium: sent / viewed / clicked">
                  Premium (sent/viewed/clicked)
                </th>
              </tr>
            </thead>
            <tbody>
              {!data || data.campaigns.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-slate-500">
                    {loading ? "Loading…" : "No campaigns"}
                  </td>
                </tr>
              ) : (
                data.campaigns.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-emerald-50/40">
                    <td className="p-2">
                      <Link href={`/campaigns/${c.id}`} className="text-emerald-700 underline hover:no-underline">
                        {c.name}
                      </Link>
                    </td>
                    <td className="p-2">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="p-2 text-right">{c.leads_count}</td>
                    <td className="p-2 text-right">
                      {c.basic.sent_count} / {c.basic.viewed_count} / {c.basic.cta_clicks}
                    </td>
                    <td className="p-2 text-right">
                      {c.premium.sent_count} / {c.premium.viewed_count} / {c.premium.cta_clicks}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: CampaignStatus }) {
  const map: Record<CampaignStatus, string> = {
    PLANEACION: "bg-amber-100 text-amber-800",
    ACTIVA: "bg-emerald-100 text-emerald-700",
    DETENIDA: "bg-slate-200 text-slate-700",
    FINALIZADA: "bg-indigo-100 text-indigo-700",
  };
  return (
    <span className={`text-[12px] px-2 py-0.5 rounded-full ${map[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function AuditsBasicSummary({ campaign }: { campaign: Campaign }) {
  const m = campaign.audits_basic;
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

  const ctaLabelMap: Record<CtaBasicVariant, string> = {
    whatsapp_premium: "WhatsApp Premium",
    calendar: "Calendar",
    whatsapp_direct: "Direct WhatsApp",
  };

  const ctaLabel =
    campaign.cta_basic_variant &&
    ctaLabelMap[campaign.cta_basic_variant as CtaBasicVariant];

  if (!hasAny) {
    return (
      <div className="text-[11px] text-slate-500">
        No metrics yet: generate Basic audits for this campaign.
        {ctaLabel && (
          <span className="ml-1">
            ({/* pequeño chip CTA */}
            CTA: {ctaLabel})
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-600">
      <span className="font-medium">Basic:</span>
      <span>{sent} sent</span>
      <span>
        · {viewed} viewed ({viewRate}% open rate)
      </span>
      <span>
        · {clicks} CTA clicks ({clickRate}% of those who viewed it)
      </span>
      {ctaLabel && (
        <span className="ml-1 px-2 py-[1px] rounded-full bg-slate-100 text-slate-600">
          CTA: {ctaLabel}
        </span>
      )}
    </div>
  );
}

function LinksTable({
  title,
  items,
  loading,
  onCopy,
  onRenew,
  onRevoke,
}: {
  title: string;
  items: LinkRow[];
  loading: boolean;
  onCopy: (t: string) => void;
  onRenew: (auditId: number) => void;
  onRevoke: (auditId: number) => void;
}) {
  return (
    <div className="rounded border">
      <div className="p-3 border-b font-medium">{title}</div>
      <div className="max-h-[38vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white border-b">
            <tr className="text-left">
              <th className="p-2 w-[20%]">place_id</th>
              <th className="p-2 w-[8ch]">Type</th>
              <th className="p-2 w-[20ch]">Expires</th>
              <th className="p-2 w-[8ch]">Views</th>
              <th className="p-2">URL</th>
              <th className="p-2 w-[22ch]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="p-4 text-slate-500">
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-4 text-slate-500">
                  No links yet.
                </td>
              </tr>
            ) : (
              items.map((r) => (
                <tr key={r.audit_id} className="border-t">
                  <td className="p-2 font-mono text-xs">{r.place_id}</td>
                  <td className="p-2">
                    {r.kind === "BASIC" ? "Basic" : "Premium"}
                  </td>
                  <td className="p-2">
                    {new Date(r.expires_at).toLocaleString()}
                  </td>
                  <td className="p-2">{r.views}</td>
                  <td className="p-2">
                    <a
                      className="text-emerald-700 underline block truncate"
                      href={r.url}
                      target="_blank"
                      title={r.url}
                    >
                      {r.url}
                    </a>
                  </td>
                  <td className="p-2 space-x-2">
                    <button
                      className="rounded border px-2 py-1 text-xs"
                      onClick={() => onCopy(r.url)}
                    >
                      Copy
                    </button>
                    <button
                      className="rounded border px-2 py-1 text-xs"
                      onClick={() => onRenew(r.audit_id)}
                    >
                      Renew
                    </button>
                    <button
                      className="rounded border px-2 py-1 text-xs text-rose-700"
                      onClick={() => onRevoke(r.audit_id)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
