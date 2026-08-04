// web/app/leads/leads_page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

type Metrics = {
  total_leads: number;
  analyzed_count: number;
  in_zone_count: number;
  out_zone_count: number;
  with_website_count?: number;
  without_website_count?: number;

  // URGENTES (sitio caído real; sin timeouts ni WAF)
  urgent_down_count?: number;

  // NUEVO: conectividad (timeouts + WAF) — contador independiente
  connectivity_bad_count?: number;

  by_type?: {
    OWN_SITE?: number;
    SOCIAL?: number;
    LINK_HUB?: number;
    MENU_QR?: number;
    MARKETPLACE?: number;
    PLATFORM_SUBDOMAIN?: number;
    NONE?: number;
  };

  by_query: { query: string; count: number }[];

  // NUEVO (widget "Sin campaña")
  without_campaign_count?: number;
};

type LeadRow = {
  place_id: string;
  name: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  website: string | null;
  phone: string | null;
  rating: number | null;
  reviews_count: number;
  owner_responses_count: number;
  query: string | null;
  in_zone: boolean;
  analyzed: boolean;

  // NUEVOS (campaña / conectividad)
  campaign_id?: number | null;
  campaign_name?: string | null;
  connectivity_bad?: boolean | null; // desactiva checkbox y muestra chip
};

type LeadDetail = {
  lead: {
    place_id: string;
    name: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    website: string | null;
    phone: string | null;
    rating: number | null;
    reviews_count: number;
    owner_responses_count: number;
    query: string | null;
    in_zone: boolean;
    maps_url?: string | null;
  };
  analysis: {
    website_exists: boolean;
    http_status: number | null;
    https_enabled: boolean;
    has_mailto: boolean;
    has_whatsapp: boolean;
    has_social: boolean;
    score: number;
    issues: string[];
    website_type?:
    | "OWN_SITE"
    | "SOCIAL"
    | "LINK_HUB"
    | "MENU_QR"
    | "MARKETPLACE"
    | "PLATFORM_SUBDOMAIN"
    | "NONE"
    | null;
    website_provider?: string | null;
    website_root_domain?: string | null;
    intention_score?: number | null; // 0–100
    priority_score?: number | null; // 0–100

    // Diagnóstico de conectividad
    waf_restricted?: boolean;
    last_http_variant?: string | null;
    last_http_method?: string | null;
    last_fetch_reason?: string | null;

    // AI (para ti)
    ai_pitch?: string | null;
    ai_checklist?: string[] | string | null;
    model_name?: string | null;
    tokens_prompt?: number;
    tokens_completion?: number;
    cost_usd?: number;
    last_checked_at?: string;
  };
};

// campañas (frontend)
type CtaBasicVariant = "whatsapp_premium" | "calendar" | "whatsapp_direct";

type Campaign = {
  id: number;
  name: string;
  status?: string | null;
  created_at?: string;
  updated_at?: string;
  leads_count?: number;
  cta_basic_variant?: CtaBasicVariant | null;
};

// Dashboard (por nicho + ciclo de vida + ranking de oportunidad)
type NicheRow = {
  query_group: string;
  total: number;
  with_own_site: number;
  without_own_site: number;
  active: number;
  possibly_closed: number;
  confirmed_closed: number;
};

type DashboardSummary = {
  overall: { total: number; with_own_site: number; without_own_site: number };
  lifecycle: { active: number; possibly_closed: number; confirmed_closed: number };
  by_niche: NicheRow[];
};

type RankingItem = {
  place_id: string;
  name: string | null;
  city: string | null;
  region: string | null;
  website: string | null;
  phone: string | null;
  query_group: string | null;
  website_type: LeadDetail["analysis"]["website_type"];
  priority_score: number;
  opportunity_score: number;
  intention_score: number;
  lead_status: "active" | "possibly_closed" | "confirmed_closed";
  needs_reanalysis: boolean;
};

const API = process.env.NEXT_PUBLIC_API_BASE || "https://api.pixelfluxcreative.com";

export default function LeadsPage() {
  // métricas
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  // filtros
  const [search, setSearch] = useState("");
  const [inZone, setInZone] = useState<"all" | "in" | "out">("all");
  const [hasWebsite, setHasWebsite] = useState<"all" | "yes" | "no">("all");
  const [analyzed, setAnalyzed] = useState<"all" | "yes" | "no">("all");
  const [queryFilter, setQueryFilter] = useState<string | null>(null);
  const [uniqueQueries, setUniqueQueries] = useState<string[]>([]);

  // URGENTES (caídos reales)
  const [urgentOnly, setUrgentOnly] = useState(false);

  // NUEVO: conectividad (timeouts + WAF)
  const [connectivityOnly, setConnectivityOnly] = useState(false);

  // filtro tri-estado por campaña: null=todas, true=con, false=sin
  const [hasCampaign, setHasCampaign] = useState<boolean | null>(null);

  // NUEVO: filtro por campaña específica via query ?campaign_id=
  const [campaignId, setCampaignId] = useState<number | null>(null);

  // tabla
  const [rows, setRows] = useState<LeadRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [limit, setLimit] = useState(50);

  // paginación
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pages = Math.max(1, Math.ceil(total / limit));

  // detalle
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busyAction, setBusyAction] = useState<"reanalyze" | "ai" | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // === Selección por checkbox
  const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set());
  const toggleSelect = (placeId: string, checked: boolean) => {
    setSelectedSet((prev) => {
      const n = new Set(prev);
      if (checked) n.add(placeId);
      else n.delete(placeId);
      return n;
    });
  };
  const clearSelected = () => setSelectedSet(new Set());

  // IDs seleccionables de la página (sólo sin campaña y sin conectividad mala)
  const pageSelectableIds = useMemo(
    () => (rows || []).filter((r) => !r.campaign_id && !r.connectivity_bad).map((r) => r.place_id),
    [rows]
  );
  const allPageChecked = useMemo(
    () => pageSelectableIds.length > 0 && pageSelectableIds.every((id) => selectedSet.has(id)),
    [pageSelectableIds, selectedSet]
  );
  const toggleSelectAllPage = () => {
    setSelectedSet((prev) => {
      const n = new Set(prev);
      const all = pageSelectableIds.length > 0 && pageSelectableIds.every((id) => n.has(id));
      if (all) pageSelectableIds.forEach((id) => n.delete(id));
      else pageSelectableIds.forEach((id) => n.add(id));
      return n;
    });
  };

  // === Sidebar colapsable
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem("px_leads_sidebar_collapsed");
      if (v === "1") setSidebarCollapsed(true);
    } catch { }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("px_leads_sidebar_collapsed", sidebarCollapsed ? "1" : "0");
    } catch { }
  }, [sidebarCollapsed]);

  // NUEVO: leer ?campaign_id= al montar
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const cid = sp.get("campaign_id");
      if (cid) {
        const n = Number(cid);
        if (!Number.isNaN(n)) {
          setCampaignId(n);
          setHasCampaign(true); // indica que sólo "con campaña"
          setPage(1);
        }
      }
    } catch { }
  }, []);

  // cargar métricas
  const refreshMetrics = async () => {
    try {
      const r = await fetch(`${API}/leads/metrics`, { credentials: "include", cache: "no-store" });
      if (r.ok) setMetrics(await r.json());
    } catch { }
  };
  useEffect(() => {
    refreshMetrics();
    // fetch unique queries
    fetch(`${API}/leads/unique-queries`, { credentials: "include", cache: "no-store" })
      .then((r) => r.ok && r.json())
      .then((data) => {
        if (Array.isArray(data)) setUniqueQueries(data);
      })
      .catch(() => { });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // helpers filtros -> QS
  const buildFilterQS = (offsetOverride?: number) => {
    const offset = typeof offsetOverride === "number" ? offsetOverride : (page - 1) * limit;
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (search) params.set("q", search);
    if (inZone === "in") params.set("in_zone", "true");
    if (inZone === "out") params.set("in_zone", "false");
    if (hasWebsite === "yes") params.set("has_website", "true");
    if (hasWebsite === "no") params.set("has_website", "false");
    if (analyzed === "yes") params.set("analyzed", "true");
    if (analyzed === "no") params.set("analyzed", "false");
    if (queryFilter) params.set("query_filter", queryFilter);

    // URGENTES reales
    if (urgentOnly) params.set("urgent", "true");

    // siempre traer datos de campaña
    params.set("include_campaign", "true");

    if (hasCampaign === true) params.set("has_campaign", "true");
    if (hasCampaign === false) params.set("has_campaign", "false");

    // NUEVO: pasar campaign_id si viene en la URL
    if (campaignId !== null) params.set("campaign_id", String(campaignId));

    // NUEVO: conectividad (timeouts/WAF)
    if (connectivityOnly) params.set("connectivity_bad", "true");

    return params;
  };

  // cargar filas
  const loadRows = async (replace = true, offsetOverride?: number) => {
    setLoadingRows(true);
    try {
      const params = buildFilterQS(offsetOverride);
      const r = await fetch(`${API}/leads?` + params.toString(), { credentials: "include", cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json();

      setTotal(Number(data.total || 0));
      const items: LeadRow[] = (data.items || []).map((it: any) => ({
        place_id: it.place_id,
        name: it.name ?? null,
        city: it.city ?? null,
        region: it.region ?? null,
        country: it.country ?? null,
        website: it.website ?? null,
        phone: it.phone ?? null,
        rating: it.rating ?? null,
        reviews_count: it.reviews_count ?? 0,
        owner_responses_count: it.owner_responses_count ?? 0,
        query: it.query ?? null,
        in_zone: !!it.in_zone,
        analyzed: !!it.analyzed,
        campaign_id: it.campaign_id ?? null,
        campaign_name: it.campaign_name ?? null,
        // NUEVO: si el API lo envía, úsalo; si no, queda undefined/false
        connectivity_bad: typeof it.connectivity_bad === "boolean" ? it.connectivity_bad : (it.connectivity_bad ? true : false),
      }));
      setRows((prev) => (replace ? items : [...prev, ...items]));
    } finally {
      setLoadingRows(false);
    }
  };
  useEffect(() => {
    loadRows(true);
    clearSelected();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    page,
    limit,
    inZone,
    hasWebsite,
    analyzed,
    queryFilter,
    urgentOnly,
    hasCampaign,
    campaignId,
    connectivityOnly, // ← conecta el filtro nuevo
  ]);

  // seleccionar lead y cargar detalle
  const selectLead = async (place_id: string) => {
    setSelected(place_id);
    setActionErr(null);
    setLoadingDetail(true);
    try {
      const r = await fetch(`${API}/leads/${encodeURIComponent(place_id)}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) return;
      const d: LeadDetail = await r.json();
      const ck = d.analysis.ai_checklist;
      if (typeof ck === "string") {
        try {
          d.analysis.ai_checklist = JSON.parse(ck);
        } catch {
          d.analysis.ai_checklist = [];
        }
      }
      setDetail(d);
      // marcar analizado localmente si corresponde
      setRows((prev) => prev.map((x) => (x.place_id === place_id ? { ...x, analyzed: true } : x)));
    } finally {
      setLoadingDetail(false);
    }
  };

  // helper: extrae un mensaje de error legible de una respuesta no-ok
  const extractErrorMessage = async (r: Response): Promise<string> => {
    try {
      const data = await r.clone().json();
      const msg = data?.detail || data?.message || data?.error;
      if (msg) return String(msg);
    } catch { }
    try {
      const text = await r.text();
      if (text) return text;
    } catch { }
    return `Action failed (HTTP ${r.status}).`;
  };

  // acciones lead
  const doReanalyze = async () => {
    if (!selected) return;
    setBusyAction("reanalyze");
    setActionErr(null);
    try {
      const r = await fetch(`${API}/leads/${encodeURIComponent(selected)}/reanalyze`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) {
        setActionErr(await extractErrorMessage(r));
        return;
      }
      const d: LeadDetail = await r.json();
      const ck = d.analysis.ai_checklist as any;
      if (typeof ck === "string") {
        try {
          d.analysis.ai_checklist = JSON.parse(ck);
        } catch {
          d.analysis.ai_checklist = [];
        }
      }
      setDetail(d);
      await refreshMetrics();
    } finally {
      setBusyAction(null);
    }
  };

  const doAI = async () => {
    if (!selected) return;
    setBusyAction("ai");
    setActionErr(null);
    try {
      const r = await fetch(`${API}/leads/${encodeURIComponent(selected)}/ai`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) {
        setActionErr(await extractErrorMessage(r));
        return;
      }
      const data = await r.json();
      setDetail((prev) =>
        prev
          ? {
            ...prev,
            analysis: {
              ...prev.analysis,
              ai_pitch: data.analysis?.ai_pitch || prev.analysis.ai_pitch,
              ai_checklist: data.analysis?.ai_checklist || prev.analysis.ai_checklist,
              model_name: data.analysis?.model_name || prev.analysis.model_name,
              tokens_prompt: data.analysis?.tokens_prompt ?? prev.analysis.tokens_prompt,
              tokens_completion: data.analysis?.tokens_completion ?? prev.analysis.tokens_completion,
              cost_usd: data.analysis?.cost_usd ?? prev.analysis.cost_usd,
              // refrescos
              website_type: data.analysis?.website_type ?? prev.analysis.website_type,
              website_provider: data.analysis?.website_provider ?? prev.analysis.website_provider,
              website_root_domain: data.analysis?.website_root_domain ?? prev.analysis.website_root_domain,
              intention_score: data.analysis?.intention_score ?? prev.analysis.intention_score,
              priority_score: data.analysis?.priority_score ?? prev.analysis.priority_score,
              // Nota: no pisamos waf_restricted/last_* aquí
            },
          }
          : prev
      );
    } finally {
      setBusyAction(null);
    }
  };

  // === Batch (AI)
  const [showBatch, setShowBatch] = useState(false);
  const [batchNeedsAI, setBatchNeedsAI] = useState(true);
  const [batchReanalyzeFirst, setBatchReanalyzeFirst] = useState(false);
  const [batchPreview, setBatchPreview] = useState<{ total: number; count: number; place_ids: string[] } | null>(null);
  const [batchEstimate, setBatchEstimate] = useState<{
    selection_count: number;
    per_item_usd_est: number;
    total_usd_est: number;
  } | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0, ok: 0, fail: 0 });
  const [batchLog, setBatchLog] = useState<{ id: string; ok: boolean; msg: string }[]>([]);
  const [batchConcurrency, setBatchConcurrency] = useState(3);
  const [batchLimit, setBatchLimit] = useState(50);

  const openBatch = async () => {
    setShowBatch(true);
    setBatchPreview(null);
    setBatchEstimate(null);
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (inZone === "in") params.set("in_zone", "true");
    if (inZone === "out") params.set("in_zone", "false");
    if (hasWebsite === "yes") params.set("has_website", "true");
    if (hasWebsite === "no") params.set("has_website", "false");
    if (analyzed === "yes") params.set("analyzed", "true");
    if (analyzed === "no") params.set("analyzed", "false");
    if (queryFilter) params.set("query_filter", queryFilter);
    if (urgentOnly) params.set("urgent", "true");
    if (campaignId !== null) params.set("campaign_id", String(campaignId));
    if (hasCampaign === true) params.set("has_campaign", "true");
    if (hasCampaign === false) params.set("has_campaign", "false");
    if (batchNeedsAI) params.set("needs_ai", "true");
    params.set("limit", String(batchLimit));
    if (connectivityOnly) params.set("connectivity_bad", "true"); // respeta el filtro

    const s = await fetch(`${API}/leads/batch/select?${params.toString()}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (s.ok) setBatchPreview(await s.json());

    const e = await fetch(`${API}/leads/batch/estimate_ai?${params.toString()}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (e.ok) setBatchEstimate(await e.json());
  };

  const runBatch = async () => {
    if (!batchPreview?.place_ids?.length) return;
    const ids = batchPreview.place_ids;
    setBatchRunning(true);
    setBatchProgress({ done: 0, total: ids.length, ok: 0, fail: 0 });
    setBatchLog([]);

    let next = 0;
    const results: Promise<void>[] = [];
    const worker = async (_i: number) => {
      while (true) {
        const idx = next++;
        if (idx >= ids.length) return;
        const pid = ids[idx];
        try {
          if (batchReanalyzeFirst) {
            const r1 = await fetch(`${API}/leads/${encodeURIComponent(pid)}/reanalyze`, {
              method: "POST",
              credentials: "include",
            });
            if (!r1.ok) throw new Error(`reanalyze ${r1.status}`);
          }
          const r2 = await fetch(`${API}/leads/${encodeURIComponent(pid)}/ai`, {
            method: "POST",
            credentials: "include",
          });
          if (!r2.ok) throw new Error(`ai ${r2.status}`);

          setBatchLog((p) => [{ id: pid, ok: true, msg: "OK" }, ...p].slice(0, 200));
          setBatchProgress((p) => ({ ...p, done: p.done + 1, ok: p.ok + 1 }));
          setRows((prev) => prev.map((x) => (x.place_id === pid ? { ...x, analyzed: true } : x)));
        } catch (err: any) {
          setBatchLog((p) => [{ id: pid, ok: false, msg: String(err?.message || "error") }, ...p].slice(0, 200));
          setBatchProgress((p) => ({ ...p, done: p.done + 1, fail: p.fail + 1 }));
        }
      }
    };
    for (let i = 0; i < Math.max(1, batchConcurrency); i++) results.push(worker(i));
    await Promise.all(results);
    setBatchRunning(false);
    refreshMetrics();
  };

  const filteredRows = useMemo(() => rows, [rows]);

  // === Dashboard (nicho + ciclo de vida + ranking) ===
  const [activeTab, setActiveTab] = useState<"catalog" | "dashboard">("catalog");
  const [dashboardData, setDashboardData] = useState<DashboardSummary | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardErr, setDashboardErr] = useState<string | null>(null);
  const [dashboardLoadedOnce, setDashboardLoadedOnce] = useState(false);

  const [rankingItems, setRankingItems] = useState<RankingItem[]>([]);
  const [rankingTotal, setRankingTotal] = useState(0);
  const [rankingOffset, setRankingOffset] = useState(0);
  const [rankingLimit] = useState(50);
  const [rankingLoading, setRankingLoading] = useState(false);
  const [rankingErr, setRankingErr] = useState<string | null>(null);

  const loadDashboardSummary = async () => {
    setDashboardLoading(true);
    setDashboardErr(null);
    try {
      const r = await fetch(`${API}/leads/dashboard`, { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setDashboardData(await r.json());
    } catch (e: any) {
      setDashboardErr(String(e?.message || e));
    } finally {
      setDashboardLoading(false);
    }
  };

  const loadRanking = async (offset: number) => {
    setRankingLoading(true);
    setRankingErr(null);
    try {
      const r = await fetch(`${API}/leads/dashboard/ranking?offset=${offset}&limit=${rankingLimit}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setRankingItems(data.items || []);
      setRankingTotal(data.total || 0);
      setRankingOffset(offset);
    } catch (e: any) {
      setRankingErr(String(e?.message || e));
    } finally {
      setRankingLoading(false);
    }
  };

  const openDashboardTab = () => {
    setActiveTab("dashboard");
    clearSelected();
    if (!dashboardLoadedOnce) {
      setDashboardLoadedOnce(true);
      loadDashboardSummary();
      loadRanking(0);
    }
  };

  const openCatalogTab = () => {
    setActiveTab("catalog");
    clearSelected();
  };

  const rankingPages = Math.max(1, Math.ceil(rankingTotal / rankingLimit));
  const rankingPage = Math.floor(rankingOffset / rankingLimit) + 1;

  // Ver un lead del ranking: cambia a la vista de catálogo y carga su detalle
  const viewLeadFromRanking = (place_id: string) => {
    setActiveTab("catalog");
    selectLead(place_id);
  };

  // === Campañas: modal, listado, crear, asignar ===
  // === Campañas: modal, listado, crear, asignar ===
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignErr, setCampaignErr] = useState<string | null>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(null);
  const [newCampaignName, setNewCampaignName] = useState("");
  const [newCampaignCtaBasic, setNewCampaignCtaBasic] =
    useState<CtaBasicVariant>("whatsapp_premium");
  const [assigning, setAssigning] = useState(false);

  const formatCtaLabel = (v?: CtaBasicVariant | null): string => {
    switch (v) {
      case "calendar":
        return "Calendar";
      case "whatsapp_direct":
        return "WhatsApp Direct";
      case "whatsapp_premium":
      default:
        return "WhatsApp Premium";
    }
  };


  const loadCampaigns = async () => {
    setCampaignsLoading(true);
    setCampaignErr(null);
    try {
      const r = await fetch(`${API}/campaigns?offset=0&limit=200`, { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const items: Campaign[] = data.items || data || [];
      setCampaigns(items);
    } catch (e: any) {
      setCampaignErr(String(e?.message || e));
    } finally {
      setCampaignsLoading(false);
    }
  };

  const openCampaignModal = async () => {
    setShowCampaignModal(true);
    setSelectedCampaignId(null);
    setNewCampaignName("");
    setNewCampaignCtaBasic("whatsapp_premium");
    await loadCampaigns();
  };


  const createCampaign = async (): Promise<Campaign | null> => {
    if (!newCampaignName.trim()) return null;
    try {
      const r = await fetch(`${API}/campaigns`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newCampaignName.trim(),
          description: null,
          cta_basic_variant: newCampaignCtaBasic,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const c: Campaign = await r.json();
      setCampaigns((prev) => [c, ...prev]);
      setSelectedCampaignId(c.id);
      return c;
    } catch (e: any) {
      setCampaignErr(`Could not create the campaign: ${String(e?.message || e)}`);
      return null;
    }
  };


  const assignToCampaign = async () => {
    if (selectedSet.size === 0) return;
    let cid = selectedCampaignId;
    setAssigning(true);
    setCampaignErr(null);
    try {
      // si pidió crear una nueva
      if (!cid && newCampaignName.trim()) {
        const created = await createCampaign();
        if (!created) throw new Error("Could not create the campaign.");
        cid = created.id;
      }
      if (!cid) throw new Error("Select or create a campaign.");

      const place_ids = Array.from(selectedSet);
      const r = await fetch(`${API}/campaigns/${cid}/add_leads`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ place_ids }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      // actualizar tabla local: setear campaign_name/id
      const name =
        campaigns.find((c) => c.id === cid)?.name || (cid === selectedCampaignId ? newCampaignName.trim() : "");
      setRows((prev) =>
        prev.map((x) =>
          selectedSet.has(x.place_id) ? { ...x, campaign_id: cid!, campaign_name: name || x.campaign_name } : x
        )
      );
      // Si los asignados venían del ranking, ya no califican como "sin campaña"
      setRankingItems((prev) => prev.filter((x) => !selectedSet.has(x.place_id)));
      clearSelected();
      refreshMetrics();
      setShowCampaignModal(false);
    } catch (e: any) {
      setCampaignErr(String(e?.message || e));
    } finally {
      setAssigning(false);
    }
  };

  return (
    <div
      className="min-h-screen bg-[#f2f8f6] text-slate-900 grid relative g-cols-smooth"
      style={{ gridTemplateColumns: `${sidebarCollapsed ? "24px" : "280px"} 1fr` }}
    >
      {/* Sidebar */}
      <aside
        className={`bg-dark text-white p-6 flex flex-col gap-4 relative overflow-hidden opacity-smooth ${sidebarCollapsed ? "opacity-0 pointer-events-none" : "opacity-100"
          }`}
        aria-hidden={sidebarCollapsed}
      >
        <div className="text-xl font-semibold">Leads</div>

        {/* Handle */}
        <button
          onClick={() => setSidebarCollapsed(true)}
          className="absolute -right-3 top-6 collapse-handle bg-emerald-600 text-white hover:bg-emerald-700"
          title="Collapse panel"
          aria-label="Collapse panel"
        >
          ‹
        </button>

        <a href="/panel" className="bg-white/10 rounded px-3 py-2 text-center hover:bg-white/20">
          Back
        </a>

        {/* Métricas rápidas */}
        <div className="space-y-2 text-sm">
          <div className="bg-white/10 rounded-lg p-3">
            <div className="text-white/80">Total</div>
            <div className="text-2xl font-semibold">{metrics?.total_leads ?? "—"}</div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="bg-white/10 rounded-lg p-3">
              <div className="text-white/80 text-xs">Analyzed</div>
              <div className="text-lg font-semibold">{metrics?.analyzed_count ?? "—"}</div>
            </div>
            <div className="bg-white/10 rounded-lg p-3">
              <div className="text-white/80 text-xs">Not analyzed</div>
              <div className="text-lg font-semibold">
                {metrics ? metrics.total_leads - (metrics.analyzed_count ?? 0) : "—"}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => {
                setHasWebsite("yes");
                setUrgentOnly(false);
                setConnectivityOnly(false);
                setHasCampaign(null);
                setPage(1);
              }}
              className={`bg-white/10 rounded-lg p-3 text-left hover:bg-white/20 ${hasWebsite === "yes" && !urgentOnly && !connectivityOnly && hasCampaign === null
                ? "ring-2 ring-emerald-400"
                : ""
                }`}
            >
              <div className="text-white/80 text-xs">With website</div>
              <div className="text-lg font-semibold">{metrics?.with_website_count ?? "—"}</div>
            </button>

            <button
              onClick={() => {
                setHasWebsite("no");
                setUrgentOnly(false);
                setConnectivityOnly(false);
                setHasCampaign(null);
                setPage(1);
              }}
              className={`bg-white/10 rounded-lg p-3 text-left hover:bg-white/20 ${hasWebsite === "no" && !urgentOnly && !connectivityOnly && hasCampaign === null
                ? "ring-2 ring-emerald-400"
                : ""
                }`}
            >
              <div className="text-white/80 text-xs">No website</div>
              <div className="text-lg font-semibold">{metrics?.without_website_count ?? "—"}</div>
            </button>
          </div>

          {/* NUEVOS widgets: Urgentes + Sin campaña */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => {
                setUrgentOnly((u) => !u);
                setConnectivityOnly(false);
                setHasWebsite("all");
                setHasCampaign(null);
                setPage(1);
              }}
              className={`bg-white/10 rounded-lg p-3 text-left hover:bg-white/20 ${urgentOnly ? "ring-2 ring-emerald-400" : ""
                }`}
              title="Real down sites (excluding timeouts and WAF)"
            >
              <div className="text-white/80 text-xs">Urgent</div>
              <div className="text-lg font-semibold">{metrics?.urgent_down_count ?? "—"}</div>
            </button>

            {/* NUEVO: Sin campaña */}
            <button
              onClick={() => {
                setHasCampaign(hasCampaign === false ? null : false); // toggle: null ↔ false
                setHasWebsite("all");
                setUrgentOnly(false);
                setConnectivityOnly(false);
                setPage(1);
              }}
              className={`bg-white/10 rounded-lg p-3 text-left hover:bg-white/20 ${hasCampaign === false ? "ring-2 ring-emerald-400" : ""
                }`}
              title="Show only leads that don't belong to any campaign"
            >
              <div className="text-white/80 text-xs">No campaign</div>
              <div className="text-lg font-semibold">{metrics?.without_campaign_count ?? 0}</div>
            </button>
          </div>

          {/* NUEVO: Conectividad (timeouts/WAF) */}
          <div>
            <button
              onClick={() => {
                setConnectivityOnly((v) => !v);
                setUrgentOnly(false);
                setHasWebsite("all");
                setHasCampaign(null);
                setPage(1);
              }}
              className={`w-full bg-white/10 rounded-lg p-3 text-left hover:bg-white/20 ${connectivityOnly ? "ring-2 ring-emerald-400" : ""
                }`}
              title="Leads with connectivity issues (timeouts/WAF). Not considered 'down'."
            >
              <div className="text-white/80 text-xs">Connectivity (timeouts/WAF)</div>
              <div className="text-lg font-semibold">{metrics?.connectivity_bad_count ?? 0}</div>
            </button>
          </div>

          {/* Detalle: ocupa el ancho completo debajo */}
          <button
            onClick={() => {
              setHasWebsite("no");
              setUrgentOnly(false);
              setConnectivityOnly(false);
              setHasCampaign(null);
              setPage(1);
            }}
            className="bg-white/10 rounded-lg p-3 text-left hover:bg-white/20"
            title="View all leads without their own website"
          >
            <div className="text-white/80 text-xs mb-1">No own website (detail)</div>
            <div className="text-[12px] leading-5 text-white/90">
              Social {metrics?.by_type?.SOCIAL ?? 0} · Link hub {metrics?.by_type?.LINK_HUB ?? 0} · Subdomains{" "}
              {metrics?.by_type?.PLATFORM_SUBDOMAIN ?? 0} · Marketplaces {metrics?.by_type?.MARKETPLACE ?? 0} · Menu/QR{" "}
              {metrics?.by_type?.MENU_QR ?? 0} · No website {metrics?.by_type?.NONE ?? 0}
            </div>
          </button>

          {/* Top queries filter removed in favor of main selector */}
        </div>

        <a className="mt-auto bg-white/10 rounded px-3 py-2 text-center hover:bg-white/20" href="/logout">
          Log out
        </a>
      </aside>

      {/* Handle (colapsado) */}
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
        {/* Callout explicativo */}
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Every lead is scored automatically: website status, contact channels, reputation signals, and buying
          intent all combine into an opportunity score that ranks who to reach out to first. Everything below — the
          catalog, the filters, and the dashboard — runs on real scoring output computed over a synthetic dataset.
        </div>

        {/* Tabs: Catálogo (detallado, con filtros) vs Dashboard (resumen ejecutivo) */}
        <div className="flex rounded-lg border overflow-hidden w-fit">
          <button
            onClick={openCatalogTab}
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
          <DashboardView
            data={dashboardData}
            loading={dashboardLoading}
            err={dashboardErr}
            onRefresh={() => { loadDashboardSummary(); loadRanking(rankingOffset); }}
            ranking={rankingItems}
            rankingTotal={rankingTotal}
            rankingLoading={rankingLoading}
            rankingErr={rankingErr}
            rankingPage={rankingPage}
            rankingPages={rankingPages}
            rankingLimit={rankingLimit}
            onRankingPage={(off) => loadRanking(off)}
            selectedSet={selectedSet}
            onToggleSelect={toggleSelect}
            onView={viewLeadFromRanking}
            onAssign={openCampaignModal}
            onClearSelected={clearSelected}
          />
        )}

        {activeTab === "catalog" && (
        <>
        {/* Filtros */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            {/* En zona */}
            <div className="flex rounded-lg border overflow-hidden">
              {(["all", "in", "out"] as const).map((opt) => (
                <button
                  key={opt}
                  className={`px-3 py-2 text-sm ${inZone === opt ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"
                    }`}
                  onClick={() => {
                    setInZone(opt);
                    setPage(1);
                  }}
                >
                  {opt === "all" ? "All" : opt === "in" ? "In zone" : "Out"}
                </button>
              ))}
            </div>

            {/* Website */}
            <div className="flex rounded-lg border overflow-hidden">
              {(["all", "yes", "no"] as const).map((opt) => (
                <button
                  key={opt}
                  className={`px-3 py-2 text-sm ${hasWebsite === opt ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"
                    }`}
                  onClick={() => {
                    setHasWebsite(opt);
                    setPage(1);
                  }}
                  title="Filter by website existence"
                >
                  {opt === "all" ? "Website: all" : opt === "yes" ? "With website" : "No website"}
                </button>
              ))}
            </div>

            {/* Analizados */}
            <div className="flex rounded-lg border overflow-hidden">
              {(["all", "yes", "no"] as const).map((opt) => (
                <button
                  key={opt}
                  className={`px-3 py-2 text-sm ${analyzed === opt ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"
                    }`}
                  onClick={() => {
                    setAnalyzed(opt);
                    setPage(1);
                  }}
                  title="Filter by saved analysis"
                >
                  {{ all: "Analyzed: all", yes: "Analyzed only", no: "Not analyzed" }[opt]}
                </button>
              ))}
            </div>

            {/* Campaña */}
            <div className="flex rounded-lg border overflow-hidden">
              {([null, true, false] as const).map((opt) => (
                <button
                  key={String(opt)}
                  className={`px-3 py-2 text-sm ${hasCampaign === opt ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"
                    }`}
                  onClick={() => {
                    setHasCampaign(opt);
                    setPage(1);
                  }}
                  title="Filter by campaign membership"
                >
                  {opt === null ? "Campaign: all" : opt === true ? "With" : "Without"}
                </button>
              ))}
            </div>

            {/* Query Filter */}
            <div className="flex rounded-lg border bg-white relative z-20">
              <QueryCombobox
                value={queryFilter}
                onChange={(val) => {
                  setQueryFilter(val);
                  setPage(1);
                }}
                options={uniqueQueries}
              />
            </div>
          </div>

          {/* Fila 2: búsqueda + acciones */}
          <div className="flex flex-wrap items-center gap-2 justify-start">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setPage(1);
                  loadRows(true);
                }
              }}
              placeholder="Search (name/city/phone/website)"
              className="w-96 rounded-lg border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white"
            />

            <button
              onClick={() => {
                setPage(1);
                loadRows(true);
              }}
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Search
            </button>

            <select
              value={limit}
              onChange={(e) => {
                setLimit(Number(e.target.value));
                setPage(1);
              }}
              className="rounded-lg border px-2 py-1.5 text-sm bg-white"
              title="Row limit"
            >
              {[25, 50, 100, 250, 500].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>

            {/* Paginación */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-600">
                Page {page} of {pages}
              </span>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-slate-50"
              >
                ← Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page >= pages}
                className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-slate-50"
              >
                Next →
              </button>
              <button
                onClick={() => loadRows(false, rows.length)}
                disabled={rows.length >= total}
                className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-slate-50"
                title="Loads the next batch and appends it below"
              >
                Load more
              </button>
            </div>

            {/* Batch AI */}
            <button
              onClick={openBatch}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-sm"
              title="Generate AI in bulk (uses current filters)"
            >
              AI batch (filtered)
            </button>

            {/* Selección + acciones (a la derecha) */}
            <div className="ml-auto flex items-center gap-2">
              <span className="text-sm text-slate-600">
                Leads: <b>{selectedSet.size}</b>
              </span>
              <button
                onClick={toggleSelectAllPage}
                className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50"
                title="Select/Deselect all leads on this page (no campaign and no connectivity issues)"
              >
                {allPageChecked ? "Clear selection (page)" : "Select page"}
              </button>
              <button
                onClick={clearSelected}
                disabled={selectedSet.size === 0}
                className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-slate-50"
              >
                Clear
              </button>
              <button
                onClick={openCampaignModal}
                disabled={selectedSet.size === 0}
                className="rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 text-sm disabled:opacity-50"
                title="Add selected leads to a campaign"
              >
                Add to campaign
              </button>
            </div>
          </div>
        </div>

        {/* Tabla + Detalle */}
        <div
          className={`grid gap-4 g-cols-smooth ${sidebarCollapsed ? "grid-cols-[65%_35%]" : "grid-cols-[1fr_360px]"
            }`}
        >
          {/* Tabla */}
          <div>
            <div className="border rounded-lg overflow-hidden bg-white">
              <div className="max-h-[calc(90vh-110px)] overflow-y-auto">
                <table className="w-full text-sm table-fixed">
                  <colgroup>
                    <col className="w-[36px]" />
                    <col className="w-[24%]" />
                    <col className="w-[14ch]" />
                    <col className="w-[12%]" />
                    <col className="w-[8%]" />
                    <col className="w-[10%]" />
                    <col className="w-[18%]" />
                    <col className="w-[10%]" />
                    <col className="w-[12%]" />
                  </colgroup>
                  <thead className="bg-white sticky top-0 z-10 border-b">
                    <tr className="text-left">
                      <th className="p-2">
                        <input
                          type="checkbox"
                          checked={allPageChecked}
                          onChange={toggleSelectAllPage}
                          title="Select/Deselect all visible leads (no campaign and no connectivity issues)"
                        />
                      </th>
                      <th className="p-2">Name</th>
                      <th className="p-2">Phone</th>
                      <th className="p-2">City</th>
                      <th className="p-2">Rating</th>
                      <th className="p-2">Reviews</th>
                      <th className="p-2">Website</th>
                      <th className="p-2">Status</th>
                      <th className="p-2">Campaign</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingRows ? (
                      <tr>
                        <td colSpan={9} className="p-6 text-center text-slate-500">
                          Loading…
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
                        const badge = oc > 0 ? "✔✔" : rc > 0 ? "✔" : "—";
                        const disabled = !!r.campaign_id || !!r.connectivity_bad;
                        return (
                          <tr
                            key={r.place_id}
                            className={`border-t hover:bg-emerald-50/40 cursor-pointer ${selected === r.place_id ? "bg-emerald-50/60" : ""
                              }`}
                            onClick={() => selectLead(r.place_id)}
                          >
                            <td className="p-2" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={selectedSet.has(r.place_id)}
                                onChange={(e) => toggleSelect(r.place_id, e.target.checked)}
                                disabled={disabled}
                                title={
                                  r.campaign_id
                                    ? "Already assigned to a campaign"
                                    : r.connectivity_bad
                                      ? "Connectivity (timeout/WAF): cannot be added"
                                      : "Select lead"
                                }
                              />
                            </td>
                            <td className="p-2">{r.name || "—"}</td>
                            <td className="p-2 whitespace-nowrap font-mono">{r.phone || "—"}</td>
                            <td className="p-2">{r.city || "—"}</td>
                            <td className="p-2">{r.rating ?? "—"}</td>
                            <td className="p-2">
                              <span
                                className={`inline-block text-[12px] leading-none px-2 py-1 rounded-full ${oc > 0
                                  ? "bg-emerald-100 text-emerald-700"
                                  : rc > 0
                                    ? "bg-emerald-50 text-emerald-700"
                                    : "bg-slate-100 text-slate-600"
                                  }`}
                                title={rc > 0 ? `${rc} reviews · ${oc} with response` : "No reviews"}
                              >
                                {badge}
                              </span>
                            </td>
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
                            <td className="p-2">
                              {r.connectivity_bad ? (
                                <span
                                  className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800"
                                  title="Connectivity issue (timeout or WAF)"
                                >
                                  Connectivity
                                </span>
                              ) : r.analyzed ? (
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                                  Analyzed
                                </span>
                              ) : (
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">
                                  New
                                </span>
                              )}
                            </td>
                            <td className="p-2">
                              {r.campaign_name ? (
                                <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-full bg-indigo-100 text-indigo-700">
                                  {r.campaign_name}
                                </span>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <div className="px-3 py-2 text-right text-xs text-slate-500 border-t">
                Loaded {rows.length} of {total} · Limit {limit} · Page {page}/{pages}
                {selectedSet.size > 0 ? ` · Selected ${selectedSet.size}` : ""}
              </div>
            </div>
          </div>

          {/* Detalle */}
          <div className="border rounded-lg bg-white p-3 h-[calc(100vh-140px)] overflow-y-auto">
            {!selected ? (
              <div className="h-full grid place-items-center text-slate-500 text-sm">Select a lead</div>
            ) : loadingDetail || !detail ? (
              <div className="p-4 text-slate-500">Loading detail…</div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold">{detail.lead.name}</div>
                    <div className="text-slate-600 text-sm">{detail.lead.phone || "—"}</div>
                    {detail.lead.website && (
                      <a href={detail.lead.website} target="_blank" className="text-emerald-700 underline text-sm">
                        {detail.lead.website.replace(/^https?:\/\//, "")}
                      </a>
                    )}
                    <div className="mt-1">
                      <TypeBadge
                        type={detail.analysis.website_type}
                        provider={detail.analysis.website_provider || detail.analysis.website_root_domain}
                        waf={!!detail.analysis.waf_restricted} // chip WAF junto al tipo
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={doReanalyze}
                      disabled={busyAction !== null}
                      className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
                      title="Recalculate heuristic (HTTP/HTTPS, links, etc.)"
                    >
                      {busyAction === "reanalyze" ? "…" : "Re-analyze"}
                    </button>
                    <button
                      onClick={doAI}
                      disabled={busyAction !== null}
                      className="rounded-md bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-sm disabled:opacity-60"
                      title="Generate Pitch + Checklist with AI"
                    >
                      {busyAction === "ai" ? "…" : "Generate/Update"}
                    </button>
                  </div>
                </div>

                {actionErr && (
                  <div className="mt-2 rounded-md bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3 py-2">
                    {actionErr}
                  </div>
                )}

                {/* Oportunidad */}
                <div className="mt-3">
                  <div className="text-xs text-slate-600 mb-1">Opportunity (0=OK, 100=Urgent)</div>
                  <div className="w-full h-2 bg-slate-100 rounded">
                    <div
                      className="h-2 rounded bg-emerald-500"
                      style={{ width: `${Math.min(100, Math.max(0, detail.analysis.score ?? 0))}%` }}
                    />
                  </div>
                  <div className="text-[12px] text-slate-500 mt-1">Score: {detail.analysis.score ?? 0}</div>
                </div>

                {/* Intención */}
                <div className="mt-3">
                  <div className="text-xs text-slate-600 mb-1">Intent (0=low, 100=high)</div>
                  <div className="w-full h-2 bg-slate-100 rounded">
                    <div
                      className="h-2 rounded bg-emerald-500"
                      style={{ width: `${Math.min(100, Math.max(0, detail.analysis.intention_score ?? 0))}%` }}
                    />
                  </div>
                  <div className="text-[12px] text-slate-500 mt-1">Score: {detail.analysis.intention_score ?? 0}</div>
                </div>

                {/* Prioridad */}
                {typeof detail.analysis.priority_score !== "undefined" && (
                  <div className="mt-2 text-[12px] text-slate-500">Priority: {detail.analysis.priority_score ?? 0}</div>
                )}

                {/* Flags */}
                <div className="mt-3 flex flex-wrap gap-2 text-[12px]">
                  <Badge ok={detail.analysis.https_enabled} label="HTTPS" />
                  <Badge ok={detail.analysis.has_mailto} label="Mailto" />
                  <Badge ok={detail.analysis.has_whatsapp} label="WhatsApp" />
                  <Badge ok={detail.analysis.has_social} label="Social" />
                  <Badge
                    ok={
                      detail.analysis.http_status !== null &&
                      detail.analysis.http_status >= 200 &&
                      detail.analysis.http_status < 400
                    }
                    label={`HTTP ${detail.analysis.http_status ?? "?"}`}
                  />
                  {/* BADGE: WAF/Restringido */}
                  {detail.analysis.waf_restricted && (
                    <span
                      className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800"
                      title="The site restricts bots/scraping (WAF/CDN). Not considered 'down'."
                    >
                      WAF/Restricted
                    </span>
                  )}
                </div>
                {(detail.analysis.last_http_method ||
                  detail.analysis.last_http_variant ||
                  detail.analysis.last_fetch_reason) && (
                    <div className="mt-1 text-[11px] text-slate-500">
                      {detail.analysis.last_http_method ? `${detail.analysis.last_http_method} · ` : ""}
                      {detail.analysis.last_http_variant ? `${detail.analysis.last_http_variant} · ` : ""}
                      {detail.analysis.last_fetch_reason || ""}
                    </div>
                  )}

                {/* Issues */}
                <div className="mt-4">
                  <div className="font-medium text-sm mb-1">Opportunities</div>
                  {detail.analysis.issues?.length ? (
                    <ul className="list-disc ml-5 text-sm space-y-1">
                      {detail.analysis.issues.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-sm text-slate-500">No observations.</div>
                  )}
                </div>

                {/* Pitch y Checklist */}
                <div className="mt-6 border-t pt-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold">Pitch (for you)</div>
                      <div className="text-xs text-slate-500">Concrete recommendations on what to offer</div>
                    </div>
                    <button
                      onClick={doAI}
                      disabled={busyAction !== null}
                      className={`px-3 py-1.5 rounded text-sm border ${busyAction ? "opacity-60 cursor-not-allowed" : "hover:bg-slate-50"
                        }`}
                      title="Generate or update the pitch"
                    >
                      {busyAction === "ai" ? "Generating…" : "Generate/Update"}
                    </button>
                  </div>

                  <div className="mt-3">
                    {detail?.analysis?.ai_pitch ? (
                      <p className="text-sm whitespace-pre-wrap leading-6">{detail.analysis.ai_pitch}</p>
                    ) : (
                      <div className="text-sm text-slate-500">Not generated yet. Press “Generate/Update”.</div>
                    )}
                  </div>

                  <div className="mt-4">
                    <div className="text-sm font-semibold">Sales checklist (for you)</div>
                    <div className="text-xs text-slate-500 mb-2">Actionable items for your offer</div>
                    {Array.isArray(detail?.analysis?.ai_checklist) && detail!.analysis!.ai_checklist!.length > 0 ? (
                      <ul className="list-disc pl-5 text-sm space-y-1">
                        {detail!.analysis!.ai_checklist!.map((item: string, idx: number) => (
                          <li key={idx}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-sm text-slate-500">No items yet.</div>
                    )}
                  </div>

                  {(detail.analysis.model_name || detail.analysis.cost_usd) && (
                    <div className="mt-3 text-[12px] text-slate-500">
                      {detail.analysis.model_name ? `Model: ${detail.analysis.model_name}` : ""}
                      {detail.analysis.cost_usd ? ` · Approx. cost: $${detail.analysis.cost_usd?.toFixed(4)}` : ""}
                    </div>
                  )}
                </div>

                {/* Links */}
                <div className="mt-4 flex gap-2">
                  {detail.lead.maps_url && (
                    <a className="text-emerald-700 underline text-sm" href={detail.lead.maps_url} target="_blank">
                      View on Maps
                    </a>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        </>
        )}
      </main>

      {/* Modal Batch */}
      {showBatch && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center z-50">
          <div className="bg-white w-[720px] max-w-[90vw] rounded-xl p-5 shadow-xl">
            <div className="flex items-start justify-between">
              <div className="text-lg font-semibold">Generate AI in bulk (current filters)</div>
              <button
                className="text-slate-500 hover:text-slate-800"
                onClick={() => !batchRunning && setShowBatch(false)}
              >
                ✕
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={batchNeedsAI} onChange={(e) => setBatchNeedsAI(e.target.checked)} />
                  Only leads without AI generated
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={batchReanalyzeFirst}
                    onChange={(e) => setBatchReanalyzeFirst(e.target.checked)}
                  />
                  Re-analyze heuristic before AI
                </label>
                <label className="flex items-center gap-2 text-sm">
                  Selection limit:
                  <select
                    value={batchLimit}
                    onChange={(e) => setBatchLimit(Number(e.target.value))}
                    className="border rounded px-2 py-1 text-sm"
                  >
                    {[25, 50, 100, 200, 500].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  Concurrency:
                  <select
                    value={batchConcurrency}
                    onChange={(e) => setBatchConcurrency(Number(e.target.value))}
                    className="border rounded px-2 py-1 text-sm"
                  >
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  onClick={openBatch}
                  disabled={batchRunning}
                  className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
                >
                  Refresh preview
                </button>

                <div className="text-sm text-slate-600 mt-2">
                  {batchPreview ? (
                    <>
                      Selection: <b>{batchPreview.count}</b> (of {batchPreview.total} possible)
                    </>
                  ) : (
                    "No preview yet…"
                  )}
                </div>
                <div className="text-sm text-slate-600">
                  {batchEstimate ? (
                    <>
                      Estimated cost: <b>${batchEstimate.total_usd_est.toFixed(4)}</b> (~$
                      {batchEstimate.per_item_usd_est.toFixed(6)} per lead)
                    </>
                  ) : (
                    "Estimated cost: —"
                  )}
                </div>
              </div>

              <div className="border rounded p-3 h-[220px] overflow-auto bg-slate-50 text-xs">
                <div className="font-medium mb-1">Sample IDs</div>
                {batchPreview?.place_ids?.length ? (
                  <ul className="space-y-1">
                    {batchPreview.place_ids.slice(0, 50).map((id) => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-slate-500">No data</div>
                )}
              </div>
            </div>

            {batchRunning && (
              <div className="mt-4">
                <div className="text-sm">
                  Progress: {batchProgress.done}/{batchProgress.total} · OK {batchProgress.ok} · Error {batchProgress.fail}
                </div>
                <div className="w-full h-2 bg-slate-200 rounded mt-1">
                  <div
                    className="h-2 bg-emerald-500 rounded"
                    style={{
                      width: `${batchProgress.total ? (batchProgress.done / batchProgress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}

            <div className="mt-4 flex justify-between items-center">
              <div className="text-xs text-slate-500">
                * Uses your current filters. You can close this modal when it's done.
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowBatch(false)}
                  disabled={batchRunning}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
                >
                  Close
                </button>
                <button
                  onClick={runBatch}
                  disabled={batchRunning || !batchPreview?.place_ids?.length}
                  className="rounded-md bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-sm disabled:opacity-60"
                >
                  {batchRunning ? "Processing…" : "Confirm and run"}
                </button>
              </div>
            </div>

            <div className="mt-3 border-t pt-3 h-[160px] overflow-auto text-xs bg-slate-50 rounded p-2">
              {batchLog.length === 0 ? (
                <div className="text-slate-500">No events yet.</div>
              ) : (
                <ul className="space-y-1">
                  {batchLog.map((l, i) => (
                    <li key={i} className={l.ok ? "text-emerald-700" : "text-rose-600"}>
                      [{l.ok ? "OK" : "ERR"}] {l.id} — {l.msg}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Agregar a campaña */}
      {showCampaignModal && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center z-50">
          <div className="bg-white w-[720px] max-w-[92vw] rounded-xl p-5 shadow-xl">
            <div className="flex items-start justify-between">
              <div className="text-lg font-semibold">Add to campaign</div>
              <button
                className="text-slate-500 hover:text-slate-800"
                onClick={() => !assigning && setShowCampaignModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4">
              {/* Elegir existente */}
              <div className="border rounded-lg p-3">
                <div className="font-medium mb-2">Choose existing campaign</div>
                {campaignsLoading ? (
                  <div className="text-sm text-slate-500">Loading campaigns…</div>
                ) : campaigns.length === 0 ? (
                  <div className="text-sm text-slate-500">No campaigns yet.</div>
                ) : (
                  <div className="space-y-2 max-h-56 overflow-auto">
                    {campaigns.map((c) => (
                      <label key={c.id} className="flex items-start gap-2 text-sm">
                        <input
                          type="radio"
                          name="campaign"
                          checked={selectedCampaignId === c.id}
                          onChange={() => setSelectedCampaignId(c.id)}
                        />
                        <span className="flex flex-col">
                          <span className="truncate">
                            {c.name}{" "}
                            {typeof c.leads_count === "number" ? (
                              <span className="text-slate-500">({c.leads_count})</span>
                            ) : null}
                          </span>
                          <span className="text-xs text-slate-500">
                            Basic CTA: {formatCtaLabel(c.cta_basic_variant)}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <button
                  onClick={loadCampaigns}
                  className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50"
                >
                  Refresh list
                </button>
              </div>

              {/* Crear nueva */}
              {/* Crear nueva */}
              <div className="border rounded-lg p-3">
                <div className="font-medium mb-2">Create new campaign</div>
                <input
                  value={newCampaignName}
                  onChange={(e) => setNewCampaignName(e.target.value)}
                  placeholder="Campaign name"
                  className="w-full rounded border p-2 text-sm"
                />

                <div className="mt-3">
                  <div className="text-xs text-slate-600 mb-1">
                    CTA for Basic audits
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { value: "whatsapp_premium", label: "WhatsApp Premium" },
                      { value: "calendar", label: "Calendar" },
                      { value: "whatsapp_direct", label: "WhatsApp Direct" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          setNewCampaignCtaBasic(opt.value as CtaBasicVariant)
                        }
                        className={
                          "rounded-full border px-3 py-1 text-xs " +
                          (newCampaignCtaBasic === opt.value
                            ? "bg-emerald-600 border-emerald-600 text-white"
                            : "border-slate-300 text-slate-700 hover:bg-slate-50")
                        }
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">
                    This CTA will be used for this campaign's Basic audits.
                  </div>
                </div>

                <button
                  onClick={createCampaign}
                  disabled={!newCampaignName.trim()}
                  className="mt-3 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  Create and select
                </button>
                <div className="text-xs text-slate-500 mt-2">
                  * If you fill in a name and don't select an existing one, it will be created automatically when you confirm.
                </div>
              </div>

            </div>

            {campaignErr && <div className="mt-3 text-sm text-rose-600">{campaignErr}</div>}

            <div className="mt-4 flex justify-between items-center">
              <div className="text-xs text-slate-500">Selected leads: {selectedSet.size}</div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCampaignModal(false)}
                  disabled={assigning}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  onClick={assignToCampaign}
                  disabled={
                    assigning || (selectedCampaignId === null && !newCampaignName.trim()) || selectedSet.size === 0
                  }
                  className="rounded-md bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 text-sm disabled:opacity-60"
                >
                  {assigning ? "Assigning…" : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardView({
  data,
  loading,
  err,
  onRefresh,
  ranking,
  rankingTotal,
  rankingLoading,
  rankingErr,
  rankingPage,
  rankingPages,
  rankingLimit,
  onRankingPage,
  selectedSet,
  onToggleSelect,
  onView,
  onAssign,
  onClearSelected,
}: {
  data: DashboardSummary | null;
  loading: boolean;
  err: string | null;
  onRefresh: () => void;
  ranking: RankingItem[];
  rankingTotal: number;
  rankingLoading: boolean;
  rankingErr: string | null;
  rankingPage: number;
  rankingPages: number;
  rankingLimit: number;
  onRankingPage: (offset: number) => void;
  selectedSet: Set<string>;
  onToggleSelect: (place_id: string, checked: boolean) => void;
  onView: (place_id: string) => void;
  onAssign: () => void;
  onClearSelected: () => void;
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

      {/* Totales generales + ciclo de vida */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="border rounded-lg bg-white p-4">
          <div className="text-xs text-slate-500">Total leads</div>
          <div className="text-2xl font-semibold">{data?.overall.total ?? "—"}</div>
          <div className="text-[11px] text-slate-500 mt-1">
            With site {data?.overall.with_own_site ?? 0} · Without site {data?.overall.without_own_site ?? 0}
          </div>
        </div>
        <div className="border rounded-lg bg-white p-4">
          <div className="text-xs text-slate-500">Active</div>
          <div className="text-2xl font-semibold text-emerald-700">{data?.lifecycle.active ?? "—"}</div>
        </div>
        <div className="border rounded-lg bg-white p-4">
          <div className="text-xs text-slate-500">Possibly closed</div>
          <div className="text-2xl font-semibold text-amber-700">{data?.lifecycle.possibly_closed ?? "—"}</div>
        </div>
        <div className="border rounded-lg bg-white p-4">
          <div className="text-xs text-slate-500">Confirmed closed</div>
          <div className="text-2xl font-semibold text-slate-500">{data?.lifecycle.confirmed_closed ?? "—"}</div>
        </div>
      </div>

      {/* Por nicho */}
      <div className="border rounded-lg bg-white overflow-hidden">
        <div className="px-4 py-2 border-b font-medium text-sm">Leads by niche/category</div>
        <div className="max-h-[360px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-white sticky top-0 border-b">
              <tr className="text-left">
                <th className="p-2">Niche (query_group)</th>
                <th className="p-2 text-right">Total</th>
                <th className="p-2 text-right">With site</th>
                <th className="p-2 text-right">Without site</th>
                <th className="p-2 text-right">Possibly closed</th>
              </tr>
            </thead>
            <tbody>
              {!data || data.by_niche.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-slate-500">
                    {loading ? "Loading…" : "No data"}
                  </td>
                </tr>
              ) : (
                data.by_niche.map((n) => (
                  <tr key={n.query_group} className="border-t">
                    <td className="p-2">{n.query_group}</td>
                    <td className="p-2 text-right">{n.total}</td>
                    <td className="p-2 text-right text-emerald-700">{n.with_own_site}</td>
                    <td className="p-2 text-right text-amber-700">{n.without_own_site}</td>
                    <td className="p-2 text-right">{n.possibly_closed > 0 ? n.possibly_closed : "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
            {data && data.by_niche.length > 0 && (
              <tfoot className="border-t bg-slate-50 font-medium">
                <tr>
                  <td className="p-2">Overall total</td>
                  <td className="p-2 text-right">{data.overall.total}</td>
                  <td className="p-2 text-right text-emerald-700">{data.overall.with_own_site}</td>
                  <td className="p-2 text-right text-amber-700">{data.overall.without_own_site}</td>
                  <td className="p-2 text-right">{data.lifecycle.possibly_closed}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Ranking de oportunidad sin campaña */}
      <div className="border rounded-lg bg-white overflow-hidden">
        <div className="px-4 py-2 border-b flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium text-sm">
            Highest-priority ranking without campaign
            <span className="text-slate-500 font-normal"> · {rankingTotal} total</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">
              Selected: <b>{selectedSet.size}</b>
            </span>
            <button
              onClick={onClearSelected}
              disabled={selectedSet.size === 0}
              className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-slate-50"
            >
              Clear
            </button>
            <button
              onClick={onAssign}
              disabled={selectedSet.size === 0}
              className="rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Add to campaign
            </button>
          </div>
        </div>
        <div className="max-h-[480px] overflow-y-auto">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-[36px]" />
              <col className="w-[24%]" />
              <col className="w-[16%]" />
              <col className="w-[14%]" />
              <col className="w-[12%]" />
              <col className="w-[14%]" />
              <col className="w-[8%]" />
            </colgroup>
            <thead className="bg-white sticky top-0 z-10 border-b">
              <tr className="text-left">
                <th className="p-2"></th>
                <th className="p-2">Name</th>
                <th className="p-2">Niche</th>
                <th className="p-2">Website</th>
                <th className="p-2 text-right">Priority</th>
                <th className="p-2">Status</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {rankingLoading ? (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-slate-500">
                    Loading…
                  </td>
                </tr>
              ) : rankingErr ? (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-rose-600">
                    {rankingErr}
                  </td>
                </tr>
              ) : ranking.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-slate-500">
                    No leads pending campaign assignment
                  </td>
                </tr>
              ) : (
                ranking.map((r) => (
                  <tr key={r.place_id} className="border-t hover:bg-emerald-50/40">
                    <td className="p-2">
                      <input
                        type="checkbox"
                        checked={selectedSet.has(r.place_id)}
                        onChange={(e) => onToggleSelect(r.place_id, e.target.checked)}
                      />
                    </td>
                    <td className="p-2 truncate" title={r.name || ""}>
                      {r.name || "—"}
                    </td>
                    <td className="p-2 truncate text-slate-600" title={r.query_group || ""}>
                      {r.query_group || "No category"}
                    </td>
                    <td className="p-2">
                      <TypeBadge type={r.website_type} />
                    </td>
                    <td className="p-2 text-right font-medium">
                      {r.priority_score}
                      {r.needs_reanalysis && (
                        <span
                          className="ml-1 text-[10px] text-slate-400"
                          title="Auto-classified, never reanalyzed with real data — its actual priority may be higher (e.g. if it has no website)"
                        >
                          (not analyzed)
                        </span>
                      )}
                    </td>
                    <td className="p-2">
                      {r.lead_status === "possibly_closed" ? (
                        <span
                          className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800"
                          title="Possibly closed: not seen in the latest runs of its query. Not confirmed."
                        >
                          Possibly closed
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[11px]">Active</span>
                      )}
                    </td>
                    <td className="p-2">
                      <button onClick={() => onView(r.place_id)} className="text-emerald-700 hover:underline text-sm">
                        View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 flex items-center justify-between border-t text-xs text-slate-500">
          <span>
            Page {rankingPage} of {rankingPages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => onRankingPage(Math.max(0, (rankingPage - 2) * rankingLimit))}
              disabled={rankingPage <= 1}
              className="rounded-lg border px-3 py-1.5 disabled:opacity-50 hover:bg-slate-50"
            >
              ← Previous
            </button>
            <button
              onClick={() => onRankingPage(rankingPage * rankingLimit)}
              disabled={rankingPage >= rankingPages}
              className="rounded-lg border px-3 py-1.5 disabled:opacity-50 hover:bg-slate-50"
            >
              Next →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded-full ${ok ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
        }`}
    >
      {label}
    </span>
  );
}

function TypeBadge({
  type,
  provider,
  waf,
}: {
  type?: LeadDetail["analysis"]["website_type"];
  provider?: string | null;
  waf?: boolean;
}) {
  const t = (type || "NONE") as NonNullable<LeadDetail["analysis"]["website_type"]>;
  const label =
    t === "OWN_SITE"
      ? "Has website (own)"
      : t === "MENU_QR"
        ? `No website (menu/QR${provider ? ` — ${provider}` : ""})`
        : t === "LINK_HUB"
          ? `No website (link hub${provider ? ` — ${provider}` : ""})`
          : t === "SOCIAL"
            ? `No website (social media${provider ? ` — ${provider}` : ""})`
            : t === "MARKETPLACE"
              ? `No website (marketplace${provider ? ` — ${provider}` : ""})`
              : t === "PLATFORM_SUBDOMAIN"
                ? `No website (subdomain${provider ? ` — ${provider}` : ""})`
                : "No website";

  const cls = t === "OWN_SITE" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800";

  return (
    <span className="inline-flex items-center gap-1">
      <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`} title={type || "NONE"}>
        {label}
      </span>
      {waf && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800"
          title="This site is protected by WAF/CDN; it restricts bot access."
        >
          WAF
        </span>
      )}
    </span>
  );
}

function QueryCombobox({
  value,
  onChange,
  options
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  options: string[];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState(value || "");

  // Update internal search when value changes externally
  useEffect(() => {
    setSearch(value || "");
  }, [value]);

  const filtered = useMemo(() => {
    if (!search && !open) return options; // Optimization
    const lower = search.toLowerCase();
    return options.filter(o => o.toLowerCase().includes(lower));
  }, [options, search, open]);

  return (
    <div className="relative w-64 h-full flex items-center">
      <input
        type="text"
        className="w-full px-3 py-2 text-sm bg-transparent hover:bg-slate-50 focus:outline-none placeholder-slate-400 text-slate-800"
        placeholder={value ? "Query: " + value : "Query: All"}
        value={open ? search : (value || "")}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setSearch("");
          setOpen(true);
        }}
        onBlur={() => {
          // Delay closing to allow clicks on options
          setTimeout(() => {
            setOpen(false);
            setSearch(value || "");
          }, 150);
        }}
      />
      {open && (
        <ul className="absolute left-0 top-full mt-1 z-50 w-full bg-white border border-slate-200 shadow-lg max-h-60 overflow-auto rounded-md">
          {(!search || "All".toLowerCase().includes(search.toLowerCase())) && (
            <li
              className="px-3 py-2 text-sm hover:bg-slate-100 cursor-pointer text-slate-700"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(null);
                setOpen(false);
                setSearch("");
              }}
            >
              Query: All
            </li>
          )}
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-slate-500">No results</li>
          ) : (
            filtered.map((opt) => (
              <li
                key={opt}
                className="px-3 py-2 text-sm hover:bg-slate-100 cursor-pointer text-slate-700 truncate"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(opt);
                  setOpen(false);
                  setSearch(opt);
                }}
                title={opt}
              >
                {opt}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
