# app/routers/leads.py
import os
import re
import time
import json
import logging
from datetime import datetime
from typing import Optional, List, Dict, Any, Tuple

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import func, or_, and_, not_, case
from sqlalchemy.orm import Session
from sqlalchemy.sql import exists

from urllib.parse import urlparse, urlunparse
import urllib.parse as urlparse

from app.db import get_db
from app.models import (
    ScraperResult,
    LeadAnalysis,
    CampaignLead,
    Campaign,
    Audit,
    AuditView,
    AuditKind,
)
from app.ai import generate_lead_copy, decorate_pitch_no_geo, _estimate_cost_usd, _get_model

# Diagnóstico web / scraping ligero
import httpx
from bs4 import BeautifulSoup

# Clasificación de dominios / URLs
import tldextract

router = APIRouter(prefix="/leads", tags=["leads"])
log = logging.getLogger("leads")

# En el demo público, nada de lo que hace un visitante dispara un fetch HTTP
# externo real ni una llamada a OpenAI en vivo — todo el análisis se
# precalcula al sembrar la data (ver seed script).
DEMO_READONLY = os.getenv("DEMO_READONLY", "true").lower() == "true"


# ---- HTTP client defaults ----
_HTTP_TIMEOUT = httpx.Timeout(connect=8.0, read=15.0, write=15.0, pool=15.0)

_HEADERS_PRIMARY = {
    "User-Agent": "Mozilla/5.0 (compatible; PixelFluxLeadAudit/1.2)",
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "es-CL,es;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

_HEADERS_CHROME = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept": _HEADERS_PRIMARY["Accept"],
    "Accept-Language": _HEADERS_PRIMARY["Accept-Language"],
}

# ---- Helpers: detecciones rápidas ----
_WHATSAPP_RE = re.compile(r"(?:wa\.me/|api\.whatsapp\.com/)", re.I)
_MAILTO_RE = re.compile(r"mailto:", re.I)
_SOCIAL_RE = re.compile(
    r"(?:facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|linkedin\.com|youtube\.com)",
    re.I,
)

def _detect_waf(headers: httpx.Headers, status: int, body_sample: str) -> bool:
    h = {k.lower(): v.lower() for k, v in headers.items()}

    # Cabeceras típicas
    waf_headers = (
        "cf-ray", "cf-cache-status", "server", "x-sucuri-id",
        "x-imperva", "x-akamai", "x-akamai-transformed", "x-cdn",
        "x-firewall", "server-timing",
    )
    if any(k in h for k in waf_headers):
        sv = h.get("server", "")
        if any(x in sv for x in ("cloudflare", "sucuri", "akamai", "imperva", "incapsula", "cloudfront")):
            return True

    # Respuestas típicas de challenge/bloqueo
    if status in (403, 429, 503):
        if "cloudflare" in h.get("server", ""):
            return True
        if "captcha" in body_sample or "challenge" in body_sample:
            return True

    return False


def _extract_link_flags(content_type: str, text: str) -> Tuple[bool, bool, bool]:
    if not content_type or "html" not in content_type.lower():
        return (False, False, False)
    snippet = text[:200_000]
    return (
        bool(_MAILTO_RE.search(snippet)),
        bool(_WHATSAPP_RE.search(snippet)),
        bool(_SOCIAL_RE.search(snippet)),
    )


# ---------- Helpers comunes ----------

# --- Listas base de proveedores por tipo (v2, ampliable) ---
SOCIAL_DOMAINS = {
    "instagram.com", "facebook.com", "fb.com", "x.com", "twitter.com", "tiktok.com", "linkedin.com", "youtube.com"
}
LINK_HUB_DOMAINS = {
    "linktr.ee", "beacons.ai", "bio.site", "campsite.bio", "taplink.cc", "carrd.co", "about.me",
    "atom.bio", "fiweex.com", "kyte.site"
}
MENU_QR_DOMAINS = {
    "choiceqr.com", "fu.do", "menu.fu.do", "pedix.app", "flipdish.com", "qrfour.com", "toteat.app", "foodjoyy.com"
}
MARKETPLACE_DOMAINS = {
    "ubereats.com", "rappi.com", "pedidosya.com", "pedidosya.cl", "tripadvisor.com", "yelp.com", "foursquare.com"
}
PLATFORM_SUBDOMAIN_DOMAINS = {
    "wixsite.com", "wordpress.com", "myshopify.com", "github.io", "webnode.page",
    "google.com", "business.site", "sites.google.com", "riel.dev"
}
WHATSAPP_HOSTS = {"wa.me", "wa.link", "whatsapp.com", "api.whatsapp.com", "pedixwpp.com"}

def _platform_like_expr(url_col):
    """
    Expr SQLAlchemy que detecta 'webs' que NO cuentan como dominio propio:
    redes sociales, link hubs, menús QR, marketplaces, subdominios tipo wixsite/wordpress/etc y hosts de WhatsApp.
    """
    all_domains = set().union(
        SOCIAL_DOMAINS,
        LINK_HUB_DOMAINS,
        MENU_QR_DOMAINS,
        MARKETPLACE_DOMAINS,
        PLATFORM_SUBDOMAIN_DOMAINS,
        WHATSAPP_HOSTS,
    )
    conds = [url_col.ilike(f"%{d}%") for d in all_domains if d]
    return or_(*conds)

def _extract_root_domain(url: str) -> Optional[str]:
    if not url:
        return None
    try:
        ext = tldextract.extract(url)
        if not ext.domain or not ext.suffix:
            return None
        return f"{ext.domain}.{ext.suffix}".lower()
    except Exception:
        return None


def _strip_embedded_url(u: str) -> str:
    """
    Si dentro del string hay otro http(s):// más adelante (ej. '... %20https:/dominio ...'),
    nos quedamos con el ÚLTIMO segmento que parece URL.
    """
    if not u:
        return ""
    i = u.rfind("http://")
    j = u.rfind("https://")
    k = max(i, j)
    return u[k:] if k > 0 else u


def _has_whatsapp_in_url(url: Optional[str]) -> bool:
    if not url:
        return False
    try:
        u = _normalize_url(url) or url
        u = u.lower()
        p = urlparse(u)
        host = p.netloc.lower()
        if any(host == h or host.endswith("." + h) for h in WHATSAPP_HOSTS):
            return True
        return ("wa.me/" in u) or ("wa.link/" in u) or ("api.whatsapp.com" in u) or ("/catalog/" in u and "whatsapp.com" in u)
    except Exception:
        return False


def _normalize_url(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    u = _strip_embedded_url(url.strip())
    if not u:
        return None
    if not re.match(r"^https?://", u, flags=re.I):
        u = "http://" + u
    try:
        p = urlparse(u)
        host = (p.netloc or "").strip()
        path = (p.path or "").strip() or "/"
        q = ("?" + p.query) if p.query else ""
        if not host:
            return None
        path = re.sub(r"/{2,}", "/", path)
        return f"{p.scheme.lower()}://{host}{path}{q}"
    except Exception:
        return u


def _classify_website(url: Optional[str]) -> Dict[str, Optional[str]]:
    """
    Clasifica la 'web' del lead en:
      website_type: OWN_SITE | SOCIAL | LINK_HUB | MENU_QR | MARKETPLACE | PLATFORM_SUBDOMAIN | NONE
      website_provider: dominio raíz detectado (instagram, linktr.ee, fu.do, wixsite.com, etc.)
      website_root_domain: eTLD+1
    """
    if not url:
        return {"website_type": "NONE", "website_provider": None, "website_root_domain": None}

    nurl = _normalize_url(url)
    if not nurl:
        return {"website_type": "NONE", "website_provider": None, "website_root_domain": None}

    try:
        ext = tldextract.extract(nurl)
    except Exception:
        return {"website_type": "NONE", "website_provider": None, "website_root_domain": None}

    root = f"{ext.domain}.{ext.suffix}".lower() if ext.domain and ext.suffix else ""
    sub = ext.subdomain.lower() if ext.subdomain else ""

    if not root:
        return {"website_type": "NONE", "website_provider": None, "website_root_domain": None}

    if any(root == h or root.endswith("." + h) for h in WHATSAPP_HOSTS):
        return {"website_type": "NONE", "website_provider": root, "website_root_domain": root}

    if root in SOCIAL_DOMAINS:
        return {"website_type": "SOCIAL", "website_provider": root, "website_root_domain": root}
    if root in LINK_HUB_DOMAINS:
        return {"website_type": "LINK_HUB", "website_provider": root, "website_root_domain": root}
    if root in MENU_QR_DOMAINS:
        return {"website_type": "MENU_QR", "website_provider": root, "website_root_domain": root}
    if root in MARKETPLACE_DOMAINS:
        return {"website_type": "MARKETPLACE", "website_provider": root, "website_root_domain": root}

    if root in PLATFORM_SUBDOMAIN_DOMAINS and sub:
        return {"website_type": "PLATFORM_SUBDOMAIN", "website_provider": root, "website_root_domain": root}

    return {"website_type": "OWN_SITE", "website_provider": None, "website_root_domain": root}


def _compute_intention_score(
    website_type: str,
    has_whatsapp_hint: bool,
    reviews_count: int,
    owner_responses_count: int,
) -> int:
    score = 0
    if website_type == "PLATFORM_SUBDOMAIN":
        score += 40
    elif website_type == "MENU_QR":
        score += 35
    elif website_type == "LINK_HUB":
        score += 30
    elif website_type == "SOCIAL":
        score += 20

    if has_whatsapp_hint:
        score += 10
    if (owner_responses_count or 0) > 0:
        score += 10
    return max(0, min(score, 100))


def _latest_results_subq(db: Session):
    return (
        db.query(func.max(ScraperResult.id).label("id"))
        .filter(ScraperResult.place_id.isnot(None))
        .group_by(ScraperResult.place_id)
        .subquery()
    )


def _get_latest_result_by_place_id(db: Session, place_id: str) -> Optional[ScraperResult]:
    sq = _latest_results_subq(db)
    return (
        db.query(ScraperResult)
        .join(sq, ScraperResult.id == sq.c.id)
        .filter(ScraperResult.place_id == place_id)
        .first()
    )


def _looks_like_waf(resp: httpx.Response, body_text: Optional[str]) -> bool:
    try:
        sc = int(resp.status_code)
    except Exception:
        sc = None

    waf_codes = {401, 403, 405, 406, 409, 429}
    if sc in waf_codes:
        return True

    hdrs = {k.lower(): v.lower() for k, v in (resp.headers or {}).items()}
    server = hdrs.get("server", "")
    via = hdrs.get("via", "")
    cf_ray = hdrs.get("cf-ray", "")
    if any(x in (server + via + cf_ray) for x in ("cloudflare", "akamai", "sucuri", "imperva", "fastly")):
        if sc and sc >= 400:
            return True

    if body_text:
        txt = body_text.lower()
        if any(k in txt for k in ("access denied", "forbidden", "firewall", "blocked", "bot", "captcha")) and sc and sc >= 400:
            return True

    return False

# --- IPv4 fallback: hace 1 GET forzado a IPv4 (sin HTTP/2) ---
def _ipv4_get_once(url: str, timeout: httpx.Timeout, headers: dict, verify_ssl: bool = True):
    try:
        resolver = httpx.DNSResolver()
        infos = resolver.getaddrinfo(urlparse.urlparse(url).hostname, 443)
        ipv4_addrs = [i[4][0] for i in infos if ":" not in i[4][0]]
        if not ipv4_addrs:
            return None, None, None, None
    except Exception:
        return None, None, None, None
    try:
        transport = httpx.HTTPTransport(http2=False, retries=0)
        with httpx.Client(timeout=timeout, transport=transport, headers=headers, verify=verify_ssl) as c:
            r = c.get(url, follow_redirects=True)
            sample = (r.text[:2048] if (r.text and isinstance(r.text, str)) else "")
            return r.status_code, sample, dict(r.headers), str(r.url)
    except Exception:
        return None, None, None, None


def _fetch_and_analyze(raw_url: str) -> dict:
    url = (raw_url or "").strip()
    if not url:
        return {
            "http_status": None, "https_enabled": False,
            "has_mailto": False, "has_whatsapp": False, "has_social": False,
            "waf_restricted": False, "last_http_variant": None,
            "last_http_method": None, "last_fetch_reason": None,
        }

    if not re.match(r"^https?://", url, flags=re.I):
        url = "https://" + url

    flags = {
        "http_status": None,
        "https_enabled": url.lower().startswith("https://"),
        "has_mailto": False,
        "has_whatsapp": _has_whatsapp_in_url(url),
        "has_social": False,
        "waf_restricted": False,
        "last_http_variant": None,
        "last_http_method": None,
        "last_fetch_reason": None,
    }

    schemes = ["https://", "http://"]
    rounds = [
        {"http2": True,  "headers": _HEADERS_PRIMARY, "label": "v1:h2"},
        {"http2": False, "headers": _HEADERS_CHROME,  "label": "v2:h1"},
    ]

    parsed = urlparse.urlparse(url)
    host = parsed.hostname or ""
    host_cands = [host] + ([f"www.{host}"] if not host.startswith("www.") else [])

    for ro in rounds:
        transport = httpx.HTTPTransport(http2=ro["http2"], retries=0)
        try:
            with httpx.Client(timeout=_HTTP_TIMEOUT, transport=transport, headers=ro["headers"], verify=True) as client:
                for scheme in schemes:
                    for h in host_cands:
                        base = f"{scheme}{h}"
                        test_url = base + (parsed.path or "/")
                        try:
                            r = client.head(test_url, follow_redirects=True)
                            flags["last_http_method"] = "HEAD"
                            flags["last_http_variant"] = f"{ro['label']}:{scheme}"
                        except httpx.TimeoutException:
                            flags["last_fetch_reason"] = "timeout(head)"
                            continue
                        except httpx.HTTPError:
                            flags["last_fetch_reason"] = "http(head)"
                            continue

                        try:
                            r = client.get(test_url, follow_redirects=True)
                            flags["last_http_method"] = "GET"
                            flags["last_http_variant"] = f"{ro['label']}:{scheme}"
                            flags["http_status"] = int(r.status_code)

                            waf = _detect_waf(r.headers, r.text[:2048] if r.text else "")
                            flags["waf_restricted"] = bool(waf)

                            if (ct := r.headers.get("content-type", "")).lower().startswith("text/html"):
                                sample = r.text[:2048] if r.text else ""
                                mailto, wsp, social = _extract_link_flags(sample)
                                flags["has_mailto"] = flags["has_mailto"] or mailto
                                flags["has_whatsapp"] = flags["has_whatsapp"] or wsp
                                flags["has_social"] = flags["has_social"] or social

                            if 200 <= flags["http_status"] < 400:
                                flags["last_fetch_reason"] = "ok"
                                return flags
                        except httpx.TimeoutException:
                            flags["last_fetch_reason"] = "timeout(get)"
                            continue
                        except httpx.HTTPStatusError as e:
                            flags["http_status"] = int(getattr(e.response, "status_code", 0) or 0)
                            flags["last_fetch_reason"] = f"status({flags['http_status']})"
                            txt = e.response.text[:2048] if getattr(e.response, "text", None) else ""
                            flags["waf_restricted"] = flags["waf_restricted"] or _detect_waf(e.response.headers, txt)
                            if 200 <= flags["http_status"] < 400:
                                return flags
                        except httpx.HTTPError:
                            flags["last_fetch_reason"] = "http(get)"
                            continue
        except Exception:
            pass

    if flags["http_status"] is None:
        st, sample, hdrs, final_url = _ipv4_get_once(url, _HTTP_TIMEOUT, _HEADERS_CHROME, verify_ssl=True)
        if st:
            flags["http_status"] = int(st)
            flags["last_http_method"] = "GET (IPv4)"
            flags["last_http_variant"] = "ipv4+https"
            flags["last_fetch_reason"] = "ok(ipv4)" if 200 <= st < 400 else f"status({st})"
            flags["waf_restricted"] = flags["waf_restricted"] or _detect_waf(hdrs or {}, sample or "")
            if sample:
                mailto, wsp, social = _extract_link_flags(sample)
                flags["has_mailto"] = flags["has_mailto"] or mailto
                flags["has_whatsapp"] = flags["has_whatsapp"] or wsp
                flags["has_social"] = flags["has_social"] or social

    return flags


def _compute_score_and_issues(flags: Dict[str, Any], reviews_count: int, owner_responses_count: int, website_exists: bool) -> Dict[str, Any]:
    score = 0
    issues: List[str] = []

    waf = bool(flags.get("waf_restricted"))
    reason = (flags.get("last_fetch_reason") or "").lower()
    is_timeout = any(tok in reason for tok in ("timeout", "timed out", "time out", "read timeout", "connect timeout"))

    if not website_exists:
        score += 75
        issues.append("No website")
    else:
        status = flags.get("http_status")
        ok = (status is not None and 200 <= int(status) < 400)

        if waf and not ok:
            score += 15
            issues.append("Protected by WAF/anti-bot (restricted access)")
        elif is_timeout and not ok:
            score += 20
            issues.append("Request timed out (slow or blocked access)")
        elif not ok:
            score += 80
            issues.append("Website is down or not responding")
        else:
            if not bool(flags.get("https_enabled")):
                score += 20
                issues.append("No HTTPS")
            if not flags.get("has_mailto", False):
                score += 10
                issues.append("No mailto (contact email)")
            if not flags.get("has_whatsapp", False):
                score += 10
                issues.append("No WhatsApp button/link")
            if not flags.get("has_social", False):
                score += 10
                issues.append("No social media links")

    if (reviews_count or 0) < 5:
        score += 5
        issues.append("Very few reviews (Google)")
    if (owner_responses_count or 0) == 0:
        score += 5
        issues.append("No owner replies to reviews")

    return {"score": min(score, 100), "issues": issues}


def _order_nulls_last(db: Session, column, desc: bool = False):
    first = column.is_(None).asc()
    second = column.desc() if desc else column.asc()
    return [first, second]


# ---------- GET /leads/unique-queries ----------
@router.get("/unique-queries", response_model=List[str])
def get_unique_queries(db: Session = Depends(get_db)):
    """
    Devuelve la lista de queries únicas usadas en el scraper.
    """
    queries = (
        db.query(ScraperResult.query)
        .filter(ScraperResult.query.isnot(None), ScraperResult.query != "")
        .distinct()
        .order_by(ScraperResult.query.asc())
        .all()
    )
    return [q[0] for q in queries]


# ---------- GET /leads/metrics ----------
@router.get("/metrics")
def get_leads_metrics(db: Session = Depends(get_db)):
    """
    Métricas para el sidebar.
    - total_leads: total de negocios (último snapshot por place_id)
    - analyzed_count: cantidad con análisis guardado
    - in_zone_count / out_zone_count
    - with_website_count / without_website_count
    - urgent_down_count: con web + HTTP no OK (excluye WAF/timeouts)
    - by_type: desglose por website_type
    - without_campaign_count
    - connectivity_bad_count: WAF o timeout (para widget Conectividad)
    """
    latest_ids = _latest_results_subq(db)

    total_leads = db.query(func.count()).select_from(latest_ids).scalar() or 0

    analyzed_count = (
        db.query(func.count(LeadAnalysis.place_id))
        .filter(
            LeadAnalysis.place_id.in_(
                db.query(ScraperResult.place_id).join(latest_ids, ScraperResult.id == latest_ids.c.id)
            )
        )
        .scalar() or 0
    )

    in_zone_count = (
        db.query(func.count())
        .select_from(ScraperResult)
        .join(latest_ids, ScraperResult.id == latest_ids.c.id)
        .filter(ScraperResult.in_zone.is_(True))
        .scalar() or 0
    )
    out_zone_count = int(total_leads) - int(in_zone_count)

    with_website_count = (
        db.query(func.count())
        .select_from(LeadAnalysis)
        .filter(
            (LeadAnalysis.website_type == "OWN_SITE") &
            (LeadAnalysis.place_id.in_(
                db.query(ScraperResult.place_id).join(latest_ids, ScraperResult.id == latest_ids.c.id)
            ))
        )
        .scalar() or 0
    )
    without_website_count = int(total_leads) - int(with_website_count)

    # Urgentes (excluye WAF y timeouts)
    urgent_down_count = (
        db.query(func.count())
        .select_from(LeadAnalysis)
        .filter(
            LeadAnalysis.place_id.in_(
                db.query(ScraperResult.place_id).join(latest_ids, ScraperResult.id == latest_ids.c.id)
            ),
            LeadAnalysis.website_exists.is_(True),
            or_(
                LeadAnalysis.http_status.is_(None),
                LeadAnalysis.http_status < 200,
                LeadAnalysis.http_status >= 400,
            ),
            not_(LeadAnalysis.waf_restricted.is_(True)),
            not_(LeadAnalysis.last_fetch_reason.ilike("%timeout%")),
        )
        .scalar() or 0
    )

    # Timeouts y WAF (para conectividad)
    timeout_count = (
        db.query(func.count())
        .select_from(LeadAnalysis)
        .filter(
            LeadAnalysis.place_id.in_(
                db.query(ScraperResult.place_id).join(latest_ids, ScraperResult.id == latest_ids.c.id)
            ),
            LeadAnalysis.last_fetch_reason.ilike("%timeout%"),
        )
        .scalar() or 0
    )
    waf_count = (
        db.query(func.count())
        .select_from(LeadAnalysis)
        .filter(
            LeadAnalysis.place_id.in_(
                db.query(ScraperResult.place_id).join(latest_ids, ScraperResult.id == latest_ids.c.id)
            ),
            LeadAnalysis.waf_restricted.is_(True),
        )
        .scalar() or 0
    )
    connectivity_bad_count = int(timeout_count) + int(waf_count)

    type_rows = (
        db.query(LeadAnalysis.website_type, func.count().label("cnt"))
        .filter(
            LeadAnalysis.place_id.in_(
                db.query(ScraperResult.place_id).join(latest_ids, ScraperResult.id == latest_ids.c.id)
            )
        )
        .group_by(LeadAnalysis.website_type)
        .all()
    )
    by_type = {
        "OWN_SITE": 0,
        "SOCIAL": 0,
        "LINK_HUB": 0,
        "MENU_QR": 0,
        "MARKETPLACE": 0,
        "PLATFORM_SUBDOMAIN": 0,
        "NONE": 0,
    }
    for t, c in type_rows:
        key = str(t) if t else "NONE"
        if key in by_type:
            by_type[key] = int(c)

    without_campaign_count = (
        db.query(func.count())
        .select_from(ScraperResult)
        .join(latest_ids, ScraperResult.id == latest_ids.c.id)
        .filter(~exists().where(CampaignLead.place_id == ScraperResult.place_id))
        .scalar() or 0
    )

    return {
        "total_leads": int(total_leads),
        "analyzed_count": int(analyzed_count),
        "in_zone_count": int(in_zone_count),
        "out_zone_count": int(out_zone_count),
        "with_website_count": int(with_website_count),
        "without_website_count": int(without_website_count),
        "urgent_down_count": int(urgent_down_count),
        "by_type": by_type,
        "without_campaign_count": int(without_campaign_count),
        "connectivity_bad_count": int(connectivity_bad_count),
        "by_query": [
            {"query": q or "", "count": int(c)}
            for (q, c) in (
                db.query(ScraperResult.query, func.count().label("cnt"))
                .join(latest_ids, ScraperResult.id == latest_ids.c.id)
                .group_by(ScraperResult.query)
                .order_by(func.count().desc())
                .all()
            )
        ],
    }


# ---------- GET /leads/dashboard (resumen por nicho + ciclo de vida, ver CONTEXT_MAP.md §9.2) ----------
@router.get("/dashboard")
def get_leads_dashboard(db: Session = Depends(get_db)):
    """
    Endpoint de solo lectura, agregado 100% en SQL (sin traer filas a Python
    para agrupar). Debe declararse ANTES de GET /{place_id} para que FastAPI
    no lo confunda con un place_id literal "dashboard" (mismo motivo por el
    que /unique-queries y /metrics están antes de /{place_id}).

    - overall: total de leads / con sitio propio / sin sitio propio (TODOS los
      leads, incluyendo possibly_closed/confirmed_closed -- es un inventario
      completo, no la lista accionable de "a quién contactar").
    - lifecycle: conteo global por lead_status.
    - by_niche: mismo desglose + lifecycle, agrupado por query_group. Los
      ScraperResult sin query_group (datos de antes del backfill de §2.4,
      ~25% del historial) se agrupan bajo "Sin categoría" en vez de perderse.
    """
    latest_ids = _latest_results_subq(db)

    niche_expr = func.coalesce(ScraperResult.query_group, "Sin categoría").label("niche")
    with_own_expr = func.sum(case((LeadAnalysis.website_type == "OWN_SITE", 1), else_=0))
    active_expr = func.sum(
        case((or_(LeadAnalysis.lead_status == "active", LeadAnalysis.lead_status.is_(None)), 1), else_=0)
    )
    possibly_expr = func.sum(case((LeadAnalysis.lead_status == "possibly_closed", 1), else_=0))
    confirmed_expr = func.sum(case((LeadAnalysis.lead_status == "confirmed_closed", 1), else_=0))

    rows = (
        db.query(
            niche_expr,
            func.count().label("total"),
            with_own_expr.label("with_own_site"),
            active_expr.label("active"),
            possibly_expr.label("possibly_closed"),
            confirmed_expr.label("confirmed_closed"),
        )
        .select_from(ScraperResult)
        .join(latest_ids, ScraperResult.id == latest_ids.c.id)
        .outerjoin(LeadAnalysis, LeadAnalysis.place_id == ScraperResult.place_id)
        .group_by(niche_expr)
        .order_by(func.count().desc())
        .all()
    )

    by_niche = []
    ov_total = ov_with = ov_active = ov_possibly = ov_confirmed = 0
    for niche, total, with_own, active, possibly, confirmed in rows:
        total = int(total or 0)
        with_own = int(with_own or 0)
        active = int(active or 0)
        possibly = int(possibly or 0)
        confirmed = int(confirmed or 0)
        ov_total += total
        ov_with += with_own
        ov_active += active
        ov_possibly += possibly
        ov_confirmed += confirmed
        by_niche.append({
            "query_group": niche,
            "total": total,
            "with_own_site": with_own,
            "without_own_site": total - with_own,
            "active": active,
            "possibly_closed": possibly,
            "confirmed_closed": confirmed,
        })

    return {
        "overall": {
            "total": ov_total,
            "with_own_site": ov_with,
            "without_own_site": ov_total - ov_with,
        },
        "lifecycle": {
            "active": ov_active,
            "possibly_closed": ov_possibly,
            "confirmed_closed": ov_confirmed,
        },
        "by_niche": by_niche,
    }


# ---------- GET /leads/dashboard/ranking (mayor prioridad, sin campaña) ----------
@router.get("/dashboard/ranking")
def get_leads_dashboard_ranking(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """
    Ranking de oportunidad: leads con mayor priority_score que NO están en
    ninguna campaña hoy (no existe fila en campaign_leads para su place_id
    -- el constraint es único global, ver models.py).

    Decisiones de diseño (documentadas también en CONTEXT_MAP.md §9.2):
    - confirmed_closed se EXCLUYE del ranking (no vale la pena venderle a un
      negocio confirmado cerrado). possibly_closed se INCLUYE (no está
      confirmado), pero cada item trae lead_status para que el frontend
      muestre un badge visible en vez de ocultarlo.
    - Orden 100% en SQL por la columna indexable priority_score (ya
      persistida) -- NO se recalcula nada al vuelo ni se dispara ningún
      fetch HTTP/IA aquí, es un endpoint puramente de lectura.
    - Límite duro de 200 por página (default 50) con offset/limit para no
      traer miles de filas de una sola vez.
    - Caveat conocido (no es un bug): los ~3.552 leads que hoy solo tienen la
      clasificación liviana automática (ver §9.1, Parte 1) y nunca fueron
      reanalizados manualmente quedan con priority_score=0 y por lo tanto
      caen al fondo del ranking, aunque muchos (ej. sin sitio web) tendrían
      un score alto real una vez reanalizados -- se marca needs_reanalysis
      para que el frontend lo comunique, en vez de fabricar un score sin
      persistirlo (que arriesgaría desviarse silenciosamente del cálculo
      oficial de /reanalyze).
    """
    latest_ids = _latest_results_subq(db)

    base = (
        db.query(ScraperResult, LeadAnalysis)
        .select_from(ScraperResult)
        .join(latest_ids, ScraperResult.id == latest_ids.c.id)
        .join(LeadAnalysis, LeadAnalysis.place_id == ScraperResult.place_id)
        .filter(LeadAnalysis.lead_status != "confirmed_closed")
        .filter(~exists().where(CampaignLead.place_id == ScraperResult.place_id))
    )

    total = base.count()

    rows = (
        base
        .order_by(LeadAnalysis.priority_score.desc(), LeadAnalysis.score.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    items = []
    for sr, la in rows:
        items.append({
            "place_id": sr.place_id,
            "name": sr.name,
            "city": sr.city,
            "region": sr.region,
            "website": sr.website,
            "phone": sr.phone_e164 or sr.phone_raw,
            "query_group": sr.query_group,
            "website_type": la.website_type,
            "priority_score": int(la.priority_score or 0),
            "opportunity_score": int(la.score or 0),
            "intention_score": int(la.intention_score or 0),
            "lead_status": la.lead_status,
            "needs_reanalysis": int(la.score or 0) == 0,
        })

    return {"total": total, "offset": offset, "limit": limit, "items": items}


# ---------- GET /leads (catálogo deduplicado por place_id) ----------
@router.get("")
def list_leads(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),

    q: Optional[str] = Query(None, description="Búsqueda: nombre/ciudad/teléfono/web"),
    in_zone: Optional[bool] = Query(None),
    has_website: Optional[bool] = Query(None),
    analyzed: Optional[bool] = Query(None),

    urgent: Optional[bool] = Query(None),
    include_campaign: bool = Query(False),
    has_campaign: Optional[bool] = Query(None),

    campaign_id: Optional[int] = Query(None, description="Devuelve sólo leads de esta campaña"),
    query_filter: Optional[str] = Query(None, description="Filtro por 'query' original"),
    connectivity_bad: Optional[bool] = Query(None, description="WAF o timeout (conectividad)"),
    db: Session = Depends(get_db),
):
    """
    Devuelve la “vista rica” de leads (1 por place_id) con filtros.
    """

    latest_sub = (
        db.query(func.max(ScraperResult.id).label("id"))
        .filter(ScraperResult.place_id.isnot(None))
        .group_by(ScraperResult.place_id)
        .subquery()
    )

    # Base: último ScraperResult por place_id + (opcional) LeadAnalysis (outerjoin)
    base = (
        db.query(ScraperResult)
        .join(latest_sub, ScraperResult.id == latest_sub.c.id)
        .outerjoin(LeadAnalysis, LeadAnalysis.place_id == ScraperResult.place_id)
    )

    # === Filtros ===
    if q:
        like = f"%{q.strip()}%"
        base = base.filter(or_(
            ScraperResult.name.ilike(like),
            ScraperResult.city.ilike(like),
            ScraperResult.region.ilike(like),
            ScraperResult.country.ilike(like),
            ScraperResult.phone.ilike(like),
            ScraperResult.website.ilike(like),
            ScraperResult.query_group.ilike(like),
        ))

    if query_filter:
        base = base.filter(ScraperResult.query == query_filter)

    if in_zone is not None:
        base = base.filter(ScraperResult.in_zone == in_zone)

    # ✅ Nuevo criterio:
    # "Tiene web" == dominio propio (LeadAnalysis.website_type == OWN_SITE)
    # Si NO está analizado, inferimos: tiene web sólo si hay website y NO es plataforma/red social/menú/etc.
    if has_website is not None:
        platform_like = _platform_like_expr(ScraperResult.website)
        website_present = and_(ScraperResult.website.isnot(None), ScraperResult.website != "")

        # Si hay análisis: manda website_type
        # Si no hay análisis: usamos heurística sobre ScraperResult.website
        own_site_expr = or_(
            LeadAnalysis.website_type == "OWN_SITE",
            and_(LeadAnalysis.id.is_(None), website_present, ~platform_like),
        )

        if has_website:
            base = base.filter(own_site_expr)
        else:
            base = base.filter(
                or_(
                    # Analizado: todo lo que NO sea OWN_SITE (incluye NULL por datos viejos)
                    and_(
                        LeadAnalysis.id.isnot(None),
                        or_(
                            LeadAnalysis.website_type.is_(None),
                            LeadAnalysis.website_type != "OWN_SITE",
                        ),
                    ),
                    # No analizado: sin website o website de plataforma/red social/menú/etc
                    and_(
                        LeadAnalysis.id.is_(None),
                        or_(
                            ScraperResult.website.is_(None),
                            ScraperResult.website == "",
                            platform_like,
                        ),
                    ),
                )
            )

    if analyzed is not None:
        exists_q = db.query(LeadAnalysis.id).filter(LeadAnalysis.place_id == ScraperResult.place_id).exists()
        base = base.filter(exists_q if analyzed else ~exists_q)

    # Urgentes (excluye WAF/timeouts)
    if urgent:
        bad = db.query(LeadAnalysis.id).filter(
            and_(
                LeadAnalysis.place_id == ScraperResult.place_id,
                or_(LeadAnalysis.http_status.is_(None), LeadAnalysis.http_status < 200, LeadAnalysis.http_status >= 400),
                not_(LeadAnalysis.waf_restricted.is_(True)),
                not_(LeadAnalysis.last_fetch_reason.ilike("%timeout%")),
            )
        ).exists()
        base = base.filter(bad)

    # Filtro de Conectividad (WAF o timeout)
    if connectivity_bad:
        bad_conn = db.query(LeadAnalysis.id).filter(
            and_(
                LeadAnalysis.place_id == ScraperResult.place_id,
                or_(
                    LeadAnalysis.waf_restricted.is_(True),
                    LeadAnalysis.last_fetch_reason.ilike("%timeout%"),
                )
            )
        ).exists()
        base = base.filter(bad_conn)

    if campaign_id is not None:
        base = base.join(CampaignLead, CampaignLead.place_id == ScraperResult.place_id)
        base = base.filter(CampaignLead.campaign_id == campaign_id)

    if has_campaign is not None and campaign_id is None:
        if has_campaign:
            base = base.filter(
                db.query(CampaignLead.id)
                .filter(CampaignLead.place_id == ScraperResult.place_id)
                .exists()
            )
        else:
            base = base.filter(
                ~db.query(CampaignLead.id)
                .filter(CampaignLead.place_id == ScraperResult.place_id)
                .exists()
            )

    total = base.count()
    order_cols = _order_nulls_last(db, ScraperResult.name, desc=False)

    rows = (
        base
        .order_by(*order_cols)
        .offset(offset)
        .limit(limit)
        .all()
    )

    # Pre-cálculo: vistas de auditoría BASIC por lead (en esta campaña)
    basic_views_by_place: Dict[str, int] = {}
    if campaign_id is not None:
        page_place_ids = [r.place_id for r in rows if getattr(r, "place_id", None)]
        if page_place_ids:
            rows_views = (
                db.query(Audit.place_id, func.count(AuditView.id).label("views"))
                .join(AuditView, AuditView.audit_id == Audit.id)
                .filter(
                    Audit.campaign_id == campaign_id,
                    Audit.kind == AuditKind.BASIC,
                    Audit.disabled.is_(False),
                    Audit.place_id.in_(page_place_ids),
                )
                .group_by(Audit.place_id)
                .all()
            )
            basic_views_by_place = {pid: int(v or 0) for pid, v in rows_views}

    # Pre-cálculo: mensaje por lead (en esta campaña)
    message_by_place: Dict[str, Optional[str]] = {}
    if campaign_id is not None:
        page_place_ids = [r.place_id for r in rows if getattr(r, "place_id", None)]
        if page_place_ids:
            rows_msg = (
                db.query(CampaignLead.place_id, CampaignLead.message)
                .filter(
                    CampaignLead.campaign_id == campaign_id,
                    CampaignLead.place_id.in_(page_place_ids),
                )
                .all()
            )
            message_by_place = {pid: msg for pid, msg in rows_msg}

    # Mapeo de respuesta (con include_campaign + conectividad_bad)
    items = []
    for r in rows:
        # Determinar conectividad mala (WAF o timeout)
        ca = (
            db.query(LeadAnalysis.waf_restricted, LeadAnalysis.last_fetch_reason)
            .filter(LeadAnalysis.place_id == r.place_id)
            .first()
        )
        connectivity_bad_flag = False
        if ca:
            waf = bool(getattr(ca, "waf_restricted", False) if not isinstance(ca, tuple) else ca[0])
            reason = (getattr(ca, "last_fetch_reason", None) if not isinstance(ca, tuple) else ca[1]) or ""
            connectivity_bad_flag = waf or ("timeout" in str(reason).lower())

        item = {
            "place_id": r.place_id,
            "name": r.name,
            "city": r.city,
            "region": r.region,
            "country": r.country,
            "website": r.website,
            "phone": r.phone,
            "rating": r.rating,
            "reviews_count": r.reviews_count or 0,
            "owner_responses_count": r.owner_responses_count or 0,
            "query": r.query,
            "query_group": r.query_group,
            "in_zone": r.in_zone,  # True/False/None (None = zona no confiable)
            "analyzed": db.query(LeadAnalysis.id)
                         .filter(LeadAnalysis.place_id == r.place_id)
                         .first() is not None,
            "connectivity_bad": connectivity_bad_flag,
        }

        if include_campaign:
            cl = (
                db.query(CampaignLead, Campaign)
                .join(Campaign, Campaign.id == CampaignLead.campaign_id)
                .filter(CampaignLead.place_id == r.place_id)
                .first()
            )
            if cl:
                item["campaign_id"] = cl.Campaign.id
                item["campaign_name"] = cl.Campaign.name
            else:
                item["campaign_id"] = None
                item["campaign_name"] = None

        # Vistas de auditoría BASIC para este lead en esta campaña
        if campaign_id is not None:
            item["audit_basic_views"] = basic_views_by_place.get(r.place_id, 0)
            item["message"] = message_by_place.get(r.place_id)

        items.append(item)

    return {"total": total, "items": items, "offset": offset, "limit": limit}



# ---------- GET /leads/{place_id} (detalle) ----------
@router.get("/{place_id}")
def get_lead_detail(place_id: str, db: Session = Depends(get_db)):
    result = _get_latest_result_by_place_id(db, place_id)
    if not result:
        raise HTTPException(status_code=404, detail="Lead no encontrado")

    la = db.query(LeadAnalysis).filter(LeadAnalysis.place_id == place_id).first()

    raw_website = (result.website or "").strip() if hasattr(result, "website") else ""
    if not la:
        c = _classify_website(raw_website)
        website_exists = (c["website_type"] == "OWN_SITE")

        if website_exists and raw_website:
            flags = {
                "website_exists": True,
                "http_status": None,
                "https_enabled": False,
                "has_mailto": False,
                "has_whatsapp": False,
                "has_social": False,
                "waf_restricted": False,
                "last_http_variant": None,
                "last_http_method": None,
                "last_fetch_reason": None,
            }
        else:
            flags = {
                "website_exists": False,
                "http_status": None,
                "https_enabled": False,
                "has_mailto": False,
                "has_whatsapp": _has_whatsapp_in_url(raw_website),
                "has_social": False,
                "waf_restricted": False,
                "last_http_variant": None,
                "last_http_method": None,
                "last_fetch_reason": None,
            }

        comp = _compute_score_and_issues(
            flags=flags,
            reviews_count=int(result.reviews_count or 0),
            owner_responses_count=int(result.owner_responses_count or 0),
            website_exists=website_exists,
        )

        analysis = {
            "website_type": c["website_type"],
            "website_provider": c["website_provider"],
            "website_root_domain": c["website_root_domain"],
            "opportunity_score": int(comp["score"]),
            "score": int(comp["score"]),
            "intention_score": _compute_intention_score(
                website_type=c["website_type"],
                has_whatsapp_hint=_has_whatsapp_in_url(raw_website),
                reviews_count=int(result.reviews_count or 0),
                owner_responses_count=int(result.owner_responses_count or 0),
            ),
            "priority_score": None,
            "issues": comp["issues"],
            "https_enabled": bool(flags.get("https_enabled")),
            "has_mailto": bool(flags.get("has_mailto")),
            "has_whatsapp": bool(flags.get("has_whatsapp")),
            "has_social": bool(flags.get("has_social")),
            "http_status": flags.get("http_status"),
            "waf_restricted": bool(flags.get("waf_restricted")),
            "last_http_variant": flags.get("last_http_variant"),
            "last_http_method": flags.get("last_http_method"),
            "last_fetch_reason": flags.get("last_fetch_reason"),
            "ai_pitch": None,
            "ai_checklist": [],
            "model_name": None,
            "tokens_prompt": 0,
            "tokens_completion": 0,
            "cost_usd": 0,
            "last_checked_at": None,
        }
    else:
        try:
            ai_ck = json.loads(la.ai_checklist) if la.ai_checklist else []
            if not isinstance(ai_ck, list):
                ai_ck = [str(ai_ck)]
        except Exception:
            ai_ck = []
        analysis = {
            "website_type": la.website_type,
            "website_provider": la.website_provider,
            "website_root_domain": la.website_root_domain,
            "opportunity_score": int(la.score or 0),
            "score": int(la.score or 0),
            "intention_score": int(la.intention_score or 0),
            "priority_score": int(la.priority_score or 0),
            "issues": json.loads(la.issues_json) if la.issues_json else [],
            "https_enabled": bool(la.https_enabled),
            "has_mailto": bool(la.has_mailto),
            "has_whatsapp": bool(la.has_whatsapp),
            "has_social": bool(la.has_social),
            "http_status": la.http_status,
            "waf_restricted": bool(getattr(la, "waf_restricted", False)),
            "last_http_variant": getattr(la, "last_http_variant", None),
            "last_http_method": getattr(la, "last_http_method", None),
            "last_fetch_reason": getattr(la, "last_fetch_reason", None),
            "ai_pitch": la.ai_pitch,
            "ai_checklist": ai_ck,
            "model_name": la.model_name,
            "tokens_prompt": int(la.tokens_prompt or 0),
            "tokens_completion": int(la.tokens_completion or 0),
            "cost_usd": float(la.cost_usd or 0),
            "last_checked_at": la.last_checked_at.isoformat() if la.last_checked_at else None,
        }

    lead = {
        "place_id": result.place_id,
        "name": result.name,
        "city": result.city,
        "region": result.region,
        "country": result.country,
        "website": result.website,
        "phone": result.phone_e164 or result.phone_raw,
        "rating": float(result.rating) if result.rating is not None else None,
        "reviews_count": int(result.reviews_count or 0),
        "owner_responses_count": int(result.owner_responses_count or 0),
        "query": result.query,
        "in_zone": result.in_zone,  # True/False/None (None = zona no confiable)
    }
    return {"lead": lead, "analysis": analysis}


# ---------- POST /leads/{place_id}/reanalyze (heurística) ----------
@router.post("/{place_id}/reanalyze")
def reanalyze_lead(place_id: str, db: Session = Depends(get_db)):
    if DEMO_READONLY:
        raise HTTPException(
            status_code=403,
            detail="Modo demo: el re-análisis en vivo está deshabilitado (haría un fetch HTTP real al sitio del lead). El análisis que ves ya fue precalculado al sembrar la demo.",
        )

    result = _get_latest_result_by_place_id(db, place_id)
    if not result:
        raise HTTPException(status_code=404, detail="Lead no encontrado")

    raw_website = (result.website or "").strip() if hasattr(result, "website") else ""
    classification = _classify_website(raw_website)
    website_type = classification["website_type"]
    website_provider = classification["website_provider"]
    website_root_domain = classification["website_root_domain"]

    website_exists = (website_type == "OWN_SITE")

    if website_exists and raw_website:
        try:
            flags = _fetch_and_analyze(raw_website)
        except Exception as e:
            flags = {
                "http_status": None,
                "https_enabled": False,
                "has_mailto": False,
                "has_whatsapp": _has_whatsapp_in_url(raw_website),
                "has_social": False,
                "waf_restricted": False,
                "last_http_variant": None,
                "last_http_method": None,
                "last_fetch_reason": f"analyze error: {e}",
            }
    else:
        flags = {
            "http_status": None,
            "https_enabled": False,
            "has_mailto": False,
            "has_whatsapp": _has_whatsapp_in_url(raw_website),
            "has_social": False,
            "waf_restricted": False,
            "last_http_variant": None,
            "last_http_method": None,
            "last_fetch_reason": None,
        }

    reviews_count = int(result.reviews_count or 0)
    owner_responses_count = int(result.owner_responses_count or 0)

    comp = _compute_score_and_issues(
        flags=flags,
        reviews_count=reviews_count,
        owner_responses_count=owner_responses_count,
        website_exists=website_exists,
    )
    opportunity_score = int(comp["score"])
    issues = comp["issues"]

    if website_type in ("LINK_HUB", "MENU_QR", "MARKETPLACE", "PLATFORM_SUBDOMAIN"):
        opportunity_score = max(opportunity_score, 60)
    if website_type == "OWN_SITE":
        status = flags.get("http_status")
        ok = (status is not None and 200 <= int(status) < 400)
        if not ok and not flags.get("waf_restricted"):
            opportunity_score = max(opportunity_score, 85)

    intention_score = _compute_intention_score(
        website_type=website_type,
        has_whatsapp_hint=bool(flags.get("has_whatsapp") or _has_whatsapp_in_url(raw_website)),
        reviews_count=reviews_count,
        owner_responses_count=owner_responses_count,
    )
    priority_score = int(round(0.7 * opportunity_score + 0.3 * intention_score))

    la = db.query(LeadAnalysis).filter(LeadAnalysis.place_id == place_id).first()
    if not la:
        la = LeadAnalysis(place_id=place_id, result_id=result.id)
        db.add(la)

    la.result_id = result.id
    la.website_exists = bool(website_exists)
    la.http_status = flags.get("http_status")
    la.https_enabled = bool(flags.get("https_enabled"))
    la.has_mailto = bool(flags.get("has_mailto"))
    la.has_whatsapp = bool(flags.get("has_whatsapp"))
    la.has_social = bool(flags.get("has_social"))
    la.score = opportunity_score
    la.issues_json = json.dumps(issues, ensure_ascii=False)
    la.website_type = website_type
    la.website_provider = website_provider
    la.website_root_domain = website_root_domain
    la.intention_score = intention_score
    la.priority_score = priority_score
    la.last_checked_at = datetime.utcnow()

    if hasattr(la, "waf_restricted"):
        la.waf_restricted = bool(flags.get("waf_restricted", False))
    if hasattr(la, "last_http_variant"):
        la.last_http_variant = flags.get("last_http_variant")
    if hasattr(la, "last_http_method"):
        la.last_http_method = flags.get("last_http_method")
    if hasattr(la, "last_fetch_reason"):
        la.last_fetch_reason = flags.get("last_fetch_reason")

    db.commit()
    db.refresh(la)

    try:
        log.info(
            "reanalyze place_id=%s status=%s waf=%s method=%s variant=%s reason=%s",
            place_id,
            str(la.http_status),
            str(getattr(la, "waf_restricted", False)),
            getattr(la, "last_http_method", None),
            getattr(la, "last_http_variant", None),
            getattr(la, "last_fetch_reason", None),
        )
    except Exception:
        pass

    analysis = {
        "website_exists": bool(getattr(la, "website_exists", website_exists)),
        "http_status": la.http_status,
        "https_enabled": bool(la.https_enabled),
        "has_mailto": bool(la.has_mailto),
        "has_whatsapp": bool(la.has_whatsapp),
        "has_social": bool(la.has_social),
        "waf_restricted": bool(getattr(la, "waf_restricted", False)),
        "last_http_variant": getattr(la, "last_http_variant", None),
        "last_http_method": getattr(la, "last_http_method", None),
        "last_fetch_reason": getattr(la, "last_fetch_reason", None),
        "score": la.score,
        "issues": issues,
        "website_type": la.website_type,
        "website_provider": la.website_provider,
        "website_root_domain": la.website_root_domain,
        "intention_score": la.intention_score,
        "priority_score": la.priority_score,
        "last_checked_at": la.last_checked_at.isoformat() if la.last_checked_at else None,
    }
    lead = {
        "place_id": result.place_id,
        "name": result.name,
        "city": result.city,
        "region": result.region,
        "country": result.country,
        "website": result.website,
        "phone": result.phone_e164 or result.phone_raw,
        "rating": float(result.rating) if result.rating is not None else None,
        "reviews_count": int(result.reviews_count or 0),
        "owner_responses_count": int(result.owner_responses_count or 0),
        "query": result.query,
        "in_zone": result.in_zone,  # True/False/None (None = zona no confiable)
    }
    return {"lead": lead, "analysis": analysis}


# ---------- POST /leads/{place_id}/ai (pitch + checklist para el vendedor) ----------
@router.post("/{place_id}/ai")
def generate_ai_for_lead(place_id: str, db: Session = Depends(get_db)):
    if DEMO_READONLY:
        raise HTTPException(
            status_code=403,
            detail="Modo demo: la generación de pitch con IA en vivo está deshabilitada (haría una llamada real a OpenAI). El pitch que ves ya fue generado con el código real al sembrar la demo.",
        )

    result = _get_latest_result_by_place_id(db, place_id)
    if not result:
        raise HTTPException(status_code=404, detail="Lead no encontrado")

    la = db.query(LeadAnalysis).filter(LeadAnalysis.place_id == place_id).first()
    if not la:
        _ = reanalyze_lead(place_id, db)
        la = db.query(LeadAnalysis).filter(LeadAnalysis.place_id == place_id).first()

    if not la:
        raise HTTPException(status_code=500, detail="No se pudo generar análisis para el lead")

    lead_payload = {
        "name": result.name,
        "website": result.website,
        "phone": result.phone_e164 or result.phone_raw,
        "rating": float(result.rating) if result.rating is not None else None,
        "reviews_count": int(result.reviews_count or 0),
        "owner_responses_count": int(result.owner_responses_count or 0),
    }

    try:
        issues_list = json.loads(la.issues_json) if la.issues_json else []
    except Exception:
        issues_list = []

    analysis_payload = {
        "website_type": la.website_type or "NONE",
        "website_provider": la.website_provider,
        "website_root_domain": la.website_root_domain,
        "opportunity_score": int(la.score or 0),
        "intention_score": int(la.intention_score or 0),
        "https_enabled": bool(la.https_enabled),
        "has_mailto": bool(la.has_mailto),
        "has_whatsapp": bool(la.has_whatsapp),
        "has_social": bool(la.has_social),
        "http_status": la.http_status,
        "issues": issues_list,
        "waf_restricted": bool(getattr(la, "waf_restricted", False)),
        "last_http_variant": getattr(la, "last_http_variant", None),
        "last_http_method": getattr(la, "last_http_method", None),
        "last_fetch_reason": getattr(la, "last_fetch_reason", None),
    }

    data, usage = generate_lead_copy(lead_payload, analysis_payload, campaign_id=la.campaign_id)

    pitch = (data.get("pitch") or "").strip()
    if decorate_pitch_no_geo:
        try:
            banned = [x for x in [result.city, result.region, result.country] if x]
            pitch = decorate_pitch_no_geo(pitch, banned)
        except Exception:
            pass

    checklist = data.get("checklist") or []
    if not isinstance(checklist, list):
        checklist = [str(checklist)]

    la.ai_pitch = pitch
    la.ai_checklist = json.dumps([str(x).strip() for x in checklist if str(x).strip()], ensure_ascii=False)

    if isinstance(usage, dict):
        la.tokens_prompt = int(usage.get("prompt_tokens", 0) or 0)
        la.tokens_completion = int(usage.get("completion_tokens", 0) or 0)

    la.last_checked_at = datetime.utcnow()
    db.add(la)
    db.commit()
    db.refresh(la)

    return {
        "lead": {
            "place_id": result.place_id,
            "name": result.name,
            "website": result.website,
            "phone": result.phone_e164 or result.phone_raw,
            "rating": float(result.rating) if result.rating is not None else None,
            "reviews_count": int(result.reviews_count or 0),
            "owner_responses_count": int(result.owner_responses_count or 0),
            "query": result.query,
            "in_zone": result.in_zone,  # True/False/None (None = zona no confiable)
        },
        "analysis": {
            "website_type": la.website_type,
            "website_provider": la.website_provider,
            "website_root_domain": la.website_root_domain,
            "opportunity_score": int(la.score or 0),
            "intention_score": int(la.intention_score or 0),
            "priority_score": int(la.priority_score or 0),
            "issues": issues_list,
            "ai_pitch": la.ai_pitch,
            "ai_checklist": json.loads(la.ai_checklist) if la.ai_checklist else [],
            "model_name": la.model_name,
            "tokens_prompt": int(la.tokens_prompt or 0),
            "tokens_completion": int(la.tokens_completion or 0),
            "cost_usd": float(la.cost_usd or 0),
            "last_checked_at": la.last_checked_at.isoformat() if la.last_checked_at else None,
            "http_status": la.http_status,
            "https_enabled": bool(la.https_enabled),
            "has_mailto": bool(la.has_mailto),
            "has_whatsapp": bool(la.has_whatsapp),
            "has_social": bool(la.has_social),
            "waf_restricted": bool(getattr(la, "waf_restricted", False)),
            "last_http_variant": getattr(la, "last_http_variant", None),
            "last_http_method": getattr(la, "last_http_method", None),
            "last_fetch_reason": getattr(la, "last_fetch_reason", None),
        },
    }


# ---------- GET /leads/select (solo place_ids por filtros) ----------
@router.get("/batch/select")
def select_place_ids(
    q: Optional[str] = Query(default=None),
    in_zone: Optional[bool] = Query(default=None),
    has_website: Optional[bool] = Query(default=None),
    query_str: Optional[str] = Query(default=None, alias="query"),
    analyzed: Optional[bool] = Query(default=None),
    needs_ai: Optional[bool] = Query(default=None, description="Solo los que no tienen AI (ai_pitch vacío)"),
    limit: int = Query(default=500, le=2000),
    db: Session = Depends(get_db),
):
    latest_ids = _latest_results_subq(db)
    base = (
        db.query(
            ScraperResult.place_id,
            ScraperResult.name,
        )
        .join(latest_ids, ScraperResult.id == latest_ids.c.id)
        .outerjoin(LeadAnalysis, LeadAnalysis.place_id == ScraperResult.place_id)
    )

    if q:
        like = f"%{q}%"
        base = base.filter(
            (ScraperResult.name.like(like)) |
            (ScraperResult.city.like(like)) |
            (ScraperResult.phone_raw.like(like)) |
            (ScraperResult.phone_e164.like(like)) |
            (ScraperResult.website.like(like))
        )

    if in_zone is not None:
        base = base.filter(ScraperResult.in_zone.is_(bool(in_zone)))

    if has_website is not None:
        if has_website:
            base = base.filter(LeadAnalysis.website_type == "OWN_SITE")
        else:
            base = base.filter((LeadAnalysis.website_type.is_(None)) | (LeadAnalysis.website_type != "OWN_SITE"))

    if query_str:
        base = base.filter(ScraperResult.query == query_str)

    if analyzed is not None:
        if analyzed:
            base = base.filter(LeadAnalysis.place_id.isnot(None))
        else:
            base = base.filter(LeadAnalysis.place_id.is_(None))

    if needs_ai is not None:
        if needs_ai:
            base = base.filter(
                (LeadAnalysis.place_id.is_(None)) |
                (LeadAnalysis.ai_pitch.is_(None)) |
                (LeadAnalysis.ai_pitch == "")
            )
        else:
            base = base.filter(
                (LeadAnalysis.ai_pitch.isnot(None)) &
                (LeadAnalysis.ai_pitch != "")
            )

    total = base.count()
    rows = base.order_by(ScraperResult.name.asc()).limit(limit).all()
    place_ids = [r.place_id for r in rows if r.place_id]

    return {"total": total, "limit": limit, "count": len(place_ids), "place_ids": place_ids}


# ---------- GET /leads/estimate_ai (estimación de costo para lote) ----------
@router.get("/batch/estimate_ai")
def estimate_ai_cost(
    q: Optional[str] = Query(default=None),
    in_zone: Optional[bool] = Query(default=None),
    has_website: Optional[bool] = Query(default=None),
    query_str: Optional[str] = Query(default=None, alias="query"),
    analyzed: Optional[bool] = Query(default=None),
    needs_ai: Optional[bool] = Query(default=True),
    db: Session = Depends(get_db),
):
    latest_ids = _latest_results_subq(db)
    base = (
        db.query(ScraperResult.place_id)
        .join(latest_ids, ScraperResult.id == latest_ids.c.id)
        .outerjoin(LeadAnalysis, LeadAnalysis.place_id == ScraperResult.place_id)
    )

    if q:
        like = f"%{q}%"
        base = base.filter(
            (ScraperResult.name.like(like)) |
            (ScraperResult.city.like(like)) |
            (ScraperResult.phone_raw.like(like)) |
            (ScraperResult.phone_e164.like(like)) |
            (ScraperResult.website.like(like))
        )

    if in_zone is not None:
        base = base.filter(ScraperResult.in_zone.is_(bool(in_zone)))

    if has_website is not None:
        if has_website:
            base = base.filter(LeadAnalysis.website_type == "OWN_SITE")
        else:
            base = base.filter((LeadAnalysis.website_type.is_(None)) | (LeadAnalysis.website_type != "OWN_SITE"))

    if query_str:
        base = base.filter(ScraperResult.query == query_str)

    if analyzed is not None:
        if analyzed:
            base = base.filter(LeadAnalysis.place_id.isnot(None))
        else:
            base = base.filter(LeadAnalysis.place_id.is_(None))

    if needs_ai is not None:
        if needs_ai:
            base = base.filter(
                (LeadAnalysis.place_id.is_(None)) |
                (LeadAnalysis.ai_pitch.is_(None)) |
                (LeadAnalysis.ai_pitch == "")
            )
        else:
            base = base.filter(
                (LeadAnalysis.ai_pitch.isnot(None)) &
                (LeadAnalysis.ai_pitch != "")
            )

    selection_count = base.count()

    tokens_row = db.query(
        func.avg(LeadAnalysis.tokens_prompt).label("avg_prompt"),
        func.avg(LeadAnalysis.tokens_completion).label("avg_completion"),
    ).filter(
        (LeadAnalysis.tokens_prompt > 0) | (LeadAnalysis.tokens_completion > 0)
    ).first()

    avg_prompt = int(tokens_row.avg_prompt or 0)
    avg_completion = int(tokens_row.avg_completion or 0)

    if avg_prompt == 0:
        avg_prompt = int(os.getenv("AI_EST_DEFAULT_PROMPT_TOKENS", "230"))
    if avg_completion == 0:
        avg_completion = int(os.getenv("AI_EST_DEFAULT_COMPLETION_TOKENS", "130"))

    input_cost = float(os.getenv("OPENAI_INPUT_COST_PER_1K", "0"))
    output_cost = float(os.getenv("OPENAI_OUTPUT_COST_PER_1K", "0"))

    per_item = (avg_prompt/1000.0)*input_cost + (avg_completion/1000.0)*output_cost
    total_usd = selection_count * per_item

    return {
        "selection_count": int(selection_count),
        "avg_prompt_tokens": avg_prompt,
        "avg_completion_tokens": avg_completion,
        "per_item_usd_est": round(per_item, 6),
        "total_usd_est": round(total_usd, 6),
        "note": "Estimado basado en promedio histórico; si no había muestras, se usaron defaults.",
    }

