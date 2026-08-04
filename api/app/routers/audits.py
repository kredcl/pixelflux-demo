# app/routers/audits.py
import os, secrets, json
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from sqlalchemy import func, and_

from app.db import get_db
from app.models import (
    Audit,
    AuditKind,
    AuditView,
    CampaignLead,
    ScraperResult,
    LeadAnalysis,
    Campaign,
    ScraperReview,   # NUEVO: para traer ejemplos de reseñas
    AuditCTAVariant, # NUEVO: enum CTA básica
    AuditEvent,      # NUEVO: eventos (cta_click, etc.)
)
from app.routers.leads import _order_nulls_last

router = APIRouter(prefix="/audits", tags=["audits"])

# Generar nuevos links de auditoría, o revocar/renovar los existentes, muta
# estado que un visitante sin login podría alcanzar directo por API — se
# deshabilita en modo demo igual que el resto de escrituras (ver
# DEMO_READONLY en main.py / scraper.py / leads.py / campaigns.py). El
# tracking de CTA clicks (más abajo) queda fuera a propósito: es la métrica
# de interactividad que la demo está pensada para mostrar.
DEMO_READONLY = os.getenv("DEMO_READONLY", "true").lower() == "true"


# ---------- Helpers básicos ----------
def _token() -> str:
    # urlsafe, impredecible; 22–32 chars
    return secrets.token_urlsafe(22)


def _now() -> datetime:
    return datetime.utcnow()


def _latest_result(db: Session, place_id: str) -> Optional[ScraperResult]:
    """
    Último ScraperResult por place_id (snapshot más reciente).
    """
    sub = (
        db.query(func.max(ScraperResult.id).label("id"))
        .filter(ScraperResult.place_id.isnot(None))
        .group_by(ScraperResult.place_id)
        .subquery()
    )
    return (
        db.query(ScraperResult)
        .join(sub, ScraperResult.id == sub.c.id)
        .filter(ScraperResult.place_id == place_id)
        .first()
    )


def _build_reputation(db: Session, sr: ScraperResult) -> Dict[str, Any]:
    """
    Bloque de reputación: resumen + pequeñas muestras de reseñas.
    Importante: NO hablamos de “tienes X opiniones”, sólo usamos
    la info de forma cualitativa.
    """
    rating = float(sr.rating) if sr.rating is not None else None
    reviews_count = sr.reviews_count or 0
    owner_resp = getattr(sr, "owner_responses_count", 0) or 0

    # Qualitative copy based on signals
    if reviews_count == 0:
        label = "Almost no visible reviews"
        summary = (
            "When someone looks you up on Google, they find almost no recent reviews. "
            "That makes it harder for people to trust and choose your business at first glance."
        )
    elif rating is not None and rating >= 4.6:
        if owner_resp > 0:
            label = "Strong reputation (and active replies)"
            summary = (
                "The reviews Google shows today are very positive, and the business replies to them. "
                "A proper website would let you make better use of that trust to turn visits into inquiries."
            )
        else:
            label = "Strong reputation (few replies)"
            summary = (
                "The visible reviews are positive, but there's almost no reply activity from the business. "
                "Replying and tidying up your online presence would reinforce that good image even further."
            )
    elif rating is not None and rating <= 3.5:
        label = "Reputation has room to improve"
        summary = (
            "The visible reviews show mixed experiences. "
            "A more polished online presence helps offset that and update how customers perceive you."
        )
    else:
        label = "Reputation with room to grow"
        summary = (
            "There are visible reviews, but there's still room to improve how you're perceived: "
            "reply to comments, showcase success stories, and better guide people who are already looking for you."
        )

    # Traemos algunas reseñas (texto) para mostrar ejemplos
    reviews = (
        db.query(ScraperReview)
        .filter(ScraperReview.place_id == sr.place_id)
        .order_by(ScraperReview.published_at.desc(), ScraperReview.id.desc())
        .limit(3)
        .all()
    )

    samples: List[Dict[str, Any]] = []
    for r in reviews:
        text = (r.text or "").strip()
        if not text:
            continue
        samples.append(
            {
                "author": (r.author or "").strip() or None,
                "rating": int(r.rating) if getattr(r, "rating", None) is not None else None,
                "text": text[:500],
                "published_at": r.published_at.isoformat() if getattr(r, "published_at", None) else None,
            }
        )

    return {
        "label": label,
        "summary": summary,
        "has_reviews": reviews_count > 0,
        "has_owner_responses": owner_resp > 0,
        "rating": rating,
        # OJO: no mostramos el número exacto de opiniones al cliente
        "samples": samples,
    }

def _clamp(n: int, lo: int = 0, hi: int = 100) -> int:
    try:
        n = int(n)
    except Exception:
        n = 0
    return max(lo, min(hi, n))


def _build_basic_scores(sr: ScraperResult, diagnostics: Dict[str, Any]) -> Dict[str, Any]:
    website_type = (diagnostics.get("website_type") or "NONE")
    has_own_site = website_type == "OWN_SITE"

    rating = float(getattr(sr, "rating", 0) or 0)
    reviews_count = int(getattr(sr, "reviews_count", 0) or 0)
    owner_resp = int(getattr(sr, "owner_responses_count", 0) or 0)

    http_status = diagnostics.get("http_status")
    https_enabled = bool(diagnostics.get("https_enabled"))
    has_whatsapp = bool(diagnostics.get("has_whatsapp"))
    has_email = bool(diagnostics.get("has_mailto"))
    has_social = bool(diagnostics.get("has_social"))

    http_ok = False
    try:
        http_ok = http_status is not None and 200 <= int(http_status) < 400
    except Exception:
        http_ok = False

    # ---- VISIBILIDAD (0–100) ----
    vis = 35
    if has_own_site:
        vis += 15
    if has_social:
        vis += 10
    if reviews_count > 0:
        # bonus suave por reseñas (sin “contar” exacto)
        vis += 10 if reviews_count >= 10 else 6
        vis += 5 if reviews_count >= 50 else 0
        vis += 5 if reviews_count >= 200 else 0
    if rating >= 4.6:
        vis += 10
    elif rating >= 4.2:
        vis += 7
    elif rating >= 3.8:
        vis += 4
    visibility_score = _clamp(vis)

    # ---- CONFIANZA (0–100) ----
    trust = 20
    if rating > 0:
        trust += int((rating / 5.0) * 50)  # 0–50 aprox
    if reviews_count > 0:
        trust += 10 if reviews_count >= 10 else 6
    if owner_resp > 0:
        trust += 5
    if has_own_site and http_ok:
        trust += 8
    if has_own_site and https_enabled:
        trust += 7
    trust_score = _clamp(trust)

    # ---- FACILIDAD DE CONTACTO / CONVERSIÓN (0–100) ----
    conv = 20
    if has_whatsapp:
        conv += 35
    if has_email:
        conv += 10
    if has_own_site and http_ok:
        conv += 20
    if not has_own_site:
        conv -= 5
    conversion_score = _clamp(conv)

    overall_score = _clamp(round((visibility_score + trust_score + conversion_score) / 3))

    # Minimal issues with 'dimension' (the UI filters by this)
    issues: list[dict] = []
    if not has_own_site:
        issues.append({"dimension": "visibility", "title": "No website of your own (own domain)."})
        issues.append({"dimension": "conversion", "title": "Without your own site, it's harder to turn searches into inquiries."})
    if has_own_site and not http_ok:
        issues.append({"dimension": "trust", "title": "The site doesn't load consistently (errors or downtime)."})
    if has_own_site and http_ok and not https_enabled:
        issues.append({"dimension": "trust", "title": "The site doesn't show HTTPS correctly."})
    if not has_whatsapp and not has_email:
        issues.append({"dimension": "conversion", "title": "No direct contact channel visible (WhatsApp or email)."})
    if reviews_count == 0:
        issues.append({"dimension": "trust", "title": "Almost no visible reviews on Google."})
    elif rating > 0 and rating < 4.0:
        issues.append({"dimension": "trust", "title": "The rating is below what's ideal for building instant trust."})

    return {
        "visibility_score": visibility_score,
        "trust_score": trust_score,
        "conversion_score": conversion_score,
        "overall_score": overall_score,
        # ya los tienes en diagnostics, pero la UI también los espera aquí
        "intention_score": int(diagnostics.get("intention_score") or 0),
        "priority_score": int(diagnostics.get("priority_score") or 0),
        "issues": issues,
    }


def _build_opportunity(sr: ScraperResult, diagnostics: Dict[str, Any]) -> Dict[str, Any]:
    """
    Bloque de oportunidad: nivel (ALTA/MEDIA/BAJA) + texto explicativo
    orientado al cliente final. No menciona conteos, sólo situación.
    """
    score = int(diagnostics.get("score") or 0)
    has_site = (diagnostics.get("website_type") == "OWN_SITE")
    http_status = diagnostics.get("http_status")
    https_enabled = bool(diagnostics.get("https_enabled"))
    has_whatsapp = bool(diagnostics.get("has_whatsapp"))
    has_mailto = bool(diagnostics.get("has_mailto"))

    if score >= 70:
        level = "HIGH"
    elif score >= 40:
        level = "MEDIUM"
    else:
        level = "LOW"

    parts: List[str] = []

    if not has_site:
        parts.append(
            "Right now your customers rely almost entirely on Google and social media to find you. "
            "Without a website of your own, you're missing out on a lot of purchase-intent searches and look less professional next to other options."
        )
    else:
        if http_status is None or not (200 <= int(http_status) < 400):
            parts.append(
                "Your site didn't respond consistently when we checked it. "
                "When a page doesn't load properly, most people simply go back and pick another business."
            )
        if not https_enabled:
            parts.append(
                "Your site doesn't show HTTPS correctly. "
                "Modern browsers flag this as 'not secure', which hurts trust."
            )

    if not has_whatsapp and not has_mailto:
        parts.append(
            "We also didn't see a clear direct contact channel (WhatsApp or email) on your current presence."
        )
    elif not has_whatsapp:
        parts.append(
            "We didn't find a direct WhatsApp button, which makes it harder for a customer to message you in one click."
        )

    if level == "HIGH":
        parts.append(
            "The good news: a few basic adjustments could turn many of those visits into real inquiries."
        )
    elif level == "MEDIUM":
        parts.append(
            "There are several quick wins that can make a real difference in how you're perceived and contacted."
        )
    else:
        parts.append(
            "The foundation isn't bad, but there are still details that can help you stand out from similar businesses."
        )

    return {
        "score": score,
        "level": level,
        "summary": " ".join(parts),
    }


def _build_payload(
    db: Session,
    place_id: str,
    kind: AuditKind,
    campaign: Optional[Campaign],
    cta_variant: Optional[AuditCTAVariant] = None,
) -> Dict[str, Any]:
    """
    Construye el payload que consume el frontend de auditoría.
    Ahora incluye la variante de CTA para las auditorías BÁSICAS.
    """
    sr = _latest_result(db, place_id)
    if not sr:
        raise HTTPException(status_code=404, detail="Lead no encontrado")

    la = db.query(LeadAnalysis).filter(LeadAnalysis.place_id == place_id).first()

    # Bloques base (no exponemos nada “sensible”)
    business = {
        "name": sr.name,
        "city": sr.city,
        "region": sr.region,
        "country": sr.country,
        "phone": sr.phone,
        "website": sr.website,
        "rating": float(sr.rating) if sr.rating is not None else None,
        "reviews_count": sr.reviews_count or 0,  # se usa internamente; el copy no muestra el número
        "maps_url": sr.maps_url,
        "query": sr.query,
    }

    diagnostics = {
        "website_type": getattr(la, "website_type", None),
        "http_status": getattr(la, "http_status", None),
        "https_enabled": bool(getattr(la, "https_enabled", False)),
        "has_mailto": bool(getattr(la, "has_mailto", False)),
        "has_whatsapp": bool(getattr(la, "has_whatsapp", False)),
        "has_social": bool(getattr(la, "has_social", False)),
        "score": int(getattr(la, "score", 0)),
        "intention_score": int(getattr(la, "intention_score", 0)),
        "priority_score": int(getattr(la, "priority_score", 0)),
        "issues": (
            json.loads(la.issues_json)
            if getattr(la, "issues_json", None)
            else []
        ),
    }
    scores = _build_basic_scores(sr, diagnostics)

    # Bloques nuevos: reputación + oportunidad
    reputation = _build_reputation(db, sr)
    opportunity = _build_opportunity(sr, diagnostics)

    # CTA efectiva (por ahora sólo se usa en BASIC)
    effective_cta: Optional[str] = None
    if kind == AuditKind.BASIC:
        if isinstance(cta_variant, AuditCTAVariant):
            effective_cta = cta_variant.value
        elif isinstance(cta_variant, str):
            effective_cta = cta_variant
        else:
            # fallback: campaña -> default global
            raw = (getattr(campaign, "cta_basic_variant", None) or "whatsapp_premium").strip().lower()
            try:
                effective_cta = AuditCTAVariant(raw).value
            except ValueError:
                effective_cta = AuditCTAVariant.WHATSAPP_PREMIUM.value

    # Copy principal para la vista (resumen)
    def _short_copy() -> str:
        base = opportunity["summary"]

        if kind == AuditKind.BASIC:
            extra = (
                " This basic audit shows you the key points of your digital presence today. "
                "If you'd like, in the Premium version we can walk you through a more complete, step-by-step plan."
            )
        else:
            extra = (
                " This Premium audit is designed so that, in a short meeting, "
                "we can turn these findings into a concrete plan for your business."
            )

        return (base + " " + extra).strip()

    payload: Dict[str, Any] = {
        "kind": kind.value,
        "business": business,
        "diagnostics": diagnostics,
        "headline": "Digital Audit"
        + (" (Basic)" if kind == AuditKind.BASIC else " (Premium)"),
        "summary": _short_copy(),
        "campaign": {"id": campaign.id, "name": campaign.name} if campaign else None,
        # NUEVOS bloques ricos para el frontend
        "reputation": reputation,
        "opportunity": opportunity,
        "scores": scores,
    }

    # Adjuntamos CTA en BASIC
    if kind == AuditKind.BASIC:
        payload["cta_variant"] = effective_cta or AuditCTAVariant.WHATSAPP_PREMIUM.value

    # Benchmarks para PREMIUM: simple (dentro de la misma query/ciudad)
    if kind == AuditKind.PREMIUM:
        order_cols = (
            _order_nulls_last(db, ScraperResult.rating, desc=True)
            + _order_nulls_last(db, ScraperResult.reviews_count, desc=True)
        )
        peers = (
            db.query(ScraperResult)
            .filter(
                ScraperResult.query == sr.query,
                ScraperResult.place_id != place_id,
            )
            .order_by(*order_cols)
            .limit(3)
            .all()
        )
        payload["benchmarks"] = [
            {
                "name": p.name,
                "rating": float(p.rating) if p.rating is not None else None,
                "reviews_count": p.reviews_count or 0,
                "website": p.website,
                "maps_url": p.maps_url,
            }
            for p in peers
        ]

    return payload


# ---------- POST /audits/campaign/{id}/basic ----------
@router.post("/campaign/{campaign_id}/basic")
def generate_basic_for_campaign(
    campaign_id: int,
    days_valid: int = 7,
    db: Session = Depends(get_db),
):
    if DEMO_READONLY:
        raise HTTPException(
            status_code=403,
            detail="Modo demo: generar nuevos links de auditoría está deshabilitado. Los links que ves ya fueron generados al sembrar la demo.",
        )
    camp = db.get(Campaign, campaign_id)
    if not camp:
        raise HTTPException(status_code=404, detail="Campaña no encontrada")

    # CTA de la campaña (normalizada) → se copia a cada Audit.cta_variant
    raw_cta = (camp.cta_basic_variant or "whatsapp_premium").strip().lower()
    try:
        cta_enum = AuditCTAVariant(raw_cta)
    except ValueError:
        cta_enum = AuditCTAVariant.WHATSAPP_PREMIUM

    pids = [
        r.place_id
        for r in db.query(CampaignLead).filter(
            CampaignLead.campaign_id == campaign_id
        ).all()
    ]
    created, skipped = 0, 0
    for pid in pids:
        exists = (
            db.query(Audit)
            .filter(
                Audit.place_id == pid,
                Audit.campaign_id == campaign_id,
                Audit.kind == AuditKind.BASIC,
                Audit.disabled.is_(False),
                Audit.expires_at > _now(),
            )
            .first()
        )
        if exists:
            skipped += 1
            continue
        a = Audit(
            token=_token(),
            kind=AuditKind.BASIC,
            place_id=pid,
            campaign_id=campaign_id,
            expires_at=_now() + timedelta(days=max(1, days_valid)),
            cta_variant=cta_enum,  # NUEVO: se guarda CTA por audit
        )
        db.add(a)
        db.flush()  # asegura 'a.id' y persiste en la sesión

        # Pre-render inline del payload para carga instantánea
        try:
            payload = _build_payload(db, pid, AuditKind.BASIC, camp, cta_enum)
            a.payload_json = json.dumps(payload, ensure_ascii=False)
            a.generated_at = _now()
        except Exception:
            # si falla, dejamos el link creado y el GET /audits/view/{token} lo generará on-demand
            pass

        created += 1
    db.commit()
    return {"requested": len(pids), "created": created, "skipped": skipped}


# ---------- POST /audits/campaign/{id}/premium ----------
@router.post("/campaign/{campaign_id}/premium")
def generate_premium_for_campaign(
    campaign_id: int,
    place_ids: List[str],
    days_valid: int = 10,
    db: Session = Depends(get_db),
):
    if DEMO_READONLY:
        raise HTTPException(
            status_code=403,
            detail="Modo demo: generar nuevos links de auditoría está deshabilitado. Los links que ves ya fueron generados al sembrar la demo.",
        )
    camp = db.get(Campaign, campaign_id)
    if not camp:
        raise HTTPException(status_code=404, detail="Campaña no encontrada")
    if not place_ids:
        return {"requested": 0, "created": 0, "skipped": 0}

    created, skipped = 0, 0
    for pid in place_ids:
        exists = (
            db.query(Audit)
            .filter(
                Audit.place_id == pid,
                Audit.campaign_id == campaign_id,
                Audit.kind == AuditKind.PREMIUM,
                Audit.disabled.is_(False),
                Audit.expires_at > _now(),
            )
            .first()
        )
        if exists:
            skipped += 1
            continue
        a = Audit(
            token=_token(),
            kind=AuditKind.PREMIUM,
            place_id=pid,
            campaign_id=campaign_id,
            expires_at=_now() + timedelta(days=max(1, days_valid)),
        )
        db.add(a)
        db.flush()

        # Pre-render inline del payload para carga instantánea
        try:
            payload = _build_payload(db, pid, AuditKind.PREMIUM, camp)
            a.payload_json = json.dumps(payload, ensure_ascii=False)
            a.generated_at = _now()
        except Exception:
            # fallback on-demand en GET /audits/view/{token}
            pass

        created += 1
    db.commit()
    return {"requested": len(place_ids), "created": created, "skipped": skipped}


# ---------- GET /audits/view/{token} ----------
@router.get("/view/{token}")
def get_audit_by_token(
    token: str, request: Request, db: Session = Depends(get_db)
):
    a = db.query(Audit).filter(Audit.token == token).first()
    if not a or a.disabled or a.expires_at <= _now():
        raise HTTPException(status_code=404, detail="Link inválido o expirado")

    # payload cache
    if not a.payload_json:
        camp = db.get(Campaign, a.campaign_id) if a.campaign_id else None
        payload = _build_payload(db, a.place_id, a.kind, camp, a.cta_variant)
        a.payload_json = json.dumps(payload, ensure_ascii=False)
        a.generated_at = _now()
    else:
        payload = json.loads(a.payload_json) if a.payload_json else {}

        # Compatibilidad hacia atrás: asegurar que cta_variant venga en el payload
        if "cta_variant" not in payload and a.kind == AuditKind.BASIC:
            if a.cta_variant is not None:
                if isinstance(a.cta_variant, AuditCTAVariant):
                    payload["cta_variant"] = a.cta_variant.value
                elif isinstance(a.cta_variant, str):
                    payload["cta_variant"] = a.cta_variant
            # si sigue vacío, aplicar default
            if not payload.get("cta_variant"):
                payload["cta_variant"] = AuditCTAVariant.WHATSAPP_PREMIUM.value

    # métricas de vista
    a.viewed_count = (a.viewed_count or 0) + 1
    a.last_view_at = _now()
    db.add(a)
    try:
        db.add(
            AuditView(
                audit_id=a.id,
                ip=request.client.host if request.client else None,
                ua=request.headers.get("user-agent", "")[:255],
            )
        )
    except Exception:
        pass
    db.commit()

    # Adjunta metadatos mínimos
    payload["_meta"] = {
        "expires_at": a.expires_at.isoformat(),
        "views": a.viewed_count,
    }
    return payload

# ---------- POST /audits/{token}/events/cta-click ----------
@router.post("/{token}/events/cta-click")
def track_cta_click(
    token: str,
    payload: Optional[Dict[str, Any]] = None,
    db: Session = Depends(get_db),
):
    """
    Registra un clic en la CTA de la auditoría (BASIC o PREMIUM).

    Se llama desde la página pública de auditoría cuando el usuario
    pulsa el botón principal de CTA.
    """
    # Validamos el token igual que en /audits/view/{token}
    a = db.query(Audit).filter(Audit.token == token).first()
    if not a or a.disabled or a.expires_at <= _now():
        raise HTTPException(status_code=404, detail="Link inválido o expirado")

    # Fuente opcional: ej. "basic_page", "premium_page"
    source: Optional[str] = None
    if payload and isinstance(payload, dict):
        raw = (payload.get("source") or "").strip()
        if raw:
            source = raw[:32]  # recorte defensivo

    ev = AuditEvent(
        audit_id=a.id,
        event_type="cta_click",
        source=source,
    )
    db.add(ev)
    db.commit()

    return {"ok": True}


# --- LISTAR LINKS POR CAMPAÑA / TIER ---
@router.get("/campaign/{campaign_id}/links")
def list_links_for_campaign(
    campaign_id: int,
    kind: AuditKind,
    db: Session = Depends(get_db),
):
    base_basic = "https://audit.pixelfluxcreative.com/a/"
    base_prem = "https://audit.pixelfluxcreative.com/p/"

    audits: List[Audit] = (
        db.query(Audit)
        .filter(Audit.campaign_id == campaign_id, Audit.kind == kind)
        .order_by(Audit.created_at.desc())
        .all()
    )

    # --- Agregación de eventos CTA por audit_id ---
    audit_ids = [a.id for a in audits]
    cta_by_audit: Dict[int, Dict[str, Any]] = {}

    if audit_ids:
        rows = (
            db.query(
                AuditEvent.audit_id.label("audit_id"),
                func.count(AuditEvent.id).label("cta_clicks"),
                func.max(AuditEvent.created_at).label("last_cta_click_at"),
            )
            .filter(
                AuditEvent.audit_id.in_(audit_ids),
                AuditEvent.event_type == "cta_click",
            )
            .group_by(AuditEvent.audit_id)
            .all()
        )

        for r in rows:
            cta_by_audit[int(r.audit_id)] = {
                "cta_clicks": int(r.cta_clicks or 0),
                "last_cta_click_at": (
                    r.last_cta_click_at.isoformat()
                    if getattr(r, "last_cta_click_at", None)
                    else None
                ),
            }

    results = []
    for a in audits:
        cta = cta_by_audit.get(a.id, {"cta_clicks": 0, "last_cta_click_at": None})
        cta_clicks = int(cta.get("cta_clicks") or 0)

        results.append(
            {
                "audit_id": a.id,
                "place_id": a.place_id,
                "kind": a.kind.value,
                "expires_at": a.expires_at.isoformat(),
                "views": a.viewed_count or 0,

                # ✅ nuevos campos por lead
                "cta_clicks": cta_clicks,
                "last_cta_click_at": cta.get("last_cta_click_at"),
                "cta_clicked": cta_clicks > 0,

                "url": (base_basic if a.kind == AuditKind.BASIC else base_prem) + a.token,
                "status": "EXPIRED" if a.expires_at <= _now() or a.disabled else "ACTIVE",
            }
        )

    return {"count": len(results), "items": results}



# --- REVOCAR (deshabilitar) LINK ---
@router.post("/{audit_id}/revoke")
def revoke_link(audit_id: int, db: Session = Depends(get_db)):
    if DEMO_READONLY:
        raise HTTPException(
            status_code=403,
            detail="Modo demo: revocar links de auditoría está deshabilitado.",
        )
    a = db.get(Audit, audit_id)
    if not a:
        raise HTTPException(status_code=404, detail="No existe")
    a.disabled = True
    db.add(a)
    db.commit()
    return {"ok": True}


# --- RENOVAR (extender TTL y rotar token) ---
@router.post("/{audit_id}/renew")
def renew_link(
    audit_id: int, days_valid: int = 7, db: Session = Depends(get_db)
):
    if DEMO_READONLY:
        raise HTTPException(
            status_code=403,
            detail="Modo demo: renovar links de auditoría está deshabilitado.",
        )
    a = db.get(Audit, audit_id)
    if not a:
        raise HTTPException(status_code=404, detail="No existe")
    a.token = _token()  # rotamos token para que links viejos no funcionen
    a.expires_at = _now() + timedelta(days=max(1, days_valid))
    a.disabled = False
    db.add(a)
    db.commit()
    return {
        "ok": True,
        "expires_at": a.expires_at.isoformat(),
        "token": a.token,
    }




