# app/routers/campaigns.py
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy.orm import Session
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.mysql import insert as mysql_insert
from datetime import datetime

import os
import hashlib
import random

from app.db import get_db
from app.models import (
    Campaign,
    CampaignLead,
    CampaignStatus,
    ScraperResult,
    LeadAnalysis,
    # NUEVO: modelos de auditorías / métricas
    Audit,
    AuditKind,
    AuditView,
    AuditEvent,
)

router = APIRouter(prefix="/campaigns", tags=["campaigns"])


# Pydantic Schemas
# -----------------------------
class CampaignCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=191)
    description: Optional[str] = Field(None, max_length=500)
    # CTA por defecto para las auditorías básicas de la campaña
    # Valores esperados: "whatsapp_premium" | "calendar" | "whatsapp_direct"
    cta_basic_variant: Optional[str] = Field(
        default="whatsapp_premium",
        description="CTA por defecto para las auditorías Básicas de esta campaña.",
    )


class CampaignUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=2, max_length=191)
    description: Optional[str] = Field(None, max_length=500)
    status: Optional[CampaignStatus] = None
    # Permite cambiar la CTA básica de la campaña
    cta_basic_variant: Optional[str] = Field(
        default=None,
        description="CTA por defecto para las auditorías Básicas de esta campaña.",
    )


class CampaignOut(BaseModel):
    id: int
    name: str
    status: CampaignStatus
    description: Optional[str] = None
    # CTA básica actual de la campaña
    cta_basic_variant: Optional[str] = None
    created_at: datetime
    updated_at: datetime | None = None
    leads_count: int

    # Pydantic v2
    model_config = ConfigDict(from_attributes=True)


class LeadIdsIn(BaseModel):
    place_ids: List[str] = Field(..., min_length=1, description="Lista de place_id únicos")


# -----------------------------
# Helpers
# -----------------------------
def _is_mysql(session: Session) -> bool:
    return session.bind is not None and session.bind.dialect.name == "mysql"


def _campaign_out_with_counts(session: Session, campaign: Campaign) -> Dict[str, Any]:
    leads_count = (
        session.query(func.count(CampaignLead.id))
        .filter(CampaignLead.campaign_id == campaign.id)
        .scalar()
        or 0
    )

    # Normalizamos la CTA básica (por si viene nula)
    cta_basic = (campaign.cta_basic_variant or "whatsapp_premium").strip().lower()

    return {
        "id": campaign.id,
        "name": campaign.name,
        "status": campaign.status,
        "description": campaign.description,
        "cta_basic_variant": cta_basic,
        "created_at": campaign.created_at,
        "updated_at": campaign.updated_at,
        "leads_count": leads_count,
    }


def _cta_key(raw: Any) -> str:
    """
    Normaliza el valor de CTA (enum / str / None) a una key string.
    """
    if raw is None:
        return "unknown"
    # Si viene como Enum, usamos .value
    val = getattr(raw, "value", raw)
    if not isinstance(val, str):
        val = str(val)
    return val.strip().lower() or "unknown"


# -----------------------------
# Endpoints
# -----------------------------
@router.get("", response_model=List[CampaignOut])
def list_campaigns(
    status: Optional[CampaignStatus] = Query(None, description="Filtra por estado"),
    db: Session = Depends(get_db),
):
    q = db.query(Campaign)
    if status:
        q = q.filter(Campaign.status == status)

    campaigns = q.order_by(Campaign.created_at.desc()).all()
    # Adjuntar conteo de leads
    enriched = [_campaign_out_with_counts(db, c) for c in campaigns]
    return enriched


@router.get("/metrics")
def campaigns_metrics(db: Session = Depends(get_db)):
    """
    Devuelve conteos por estado para los chips:
      { "PLANEACION": 3, "ACTIVA": 1, "DETENIDA": 0, "FINALIZADA": 2 }
    """
    rows = db.query(Campaign.status, func.count(Campaign.id)).group_by(Campaign.status).all()
    result = {status.value: 0 for status in CampaignStatus}
    for status, count in rows:
        result[status.value] = count
    return result


@router.get("/dashboard")
def campaigns_dashboard(db: Session = Depends(get_db)):
    """
    Dashboard agregado de campañas (ver CONTEXT_MAP.md §6.6, decisión ya
    tomada por Derek: se construye ahora aunque la actividad real sea baja,
    como infraestructura para cuando crezca).

    Se declara ANTES de GET /{campaign_id} por el mismo motivo que en
    leads.py, aunque acá {campaign_id} es `int` (Starlette no lo confundiría
    con "dashboard" al no matchear el regex numérico) -- se mantiene el orden
    de todos modos por claridad y consistencia con el resto del código.

    - by_status / total_campaigns / total_leads_assigned: igual que
      GET /campaigns/metrics pero en el mismo payload que el resto del
      dashboard (no se modifica /campaigns/metrics, que el frontend ya usa
      tal cual para los chips por estado).
    - funnel: agregado GLOBAL por kind (BASIC y PREMIUM en paralelo, aunque
      PREMIUM esté hoy en cero -- ver §6.6). "viewed_count" cuenta auditorías
      DISTINTAS con ≥1 vista (mismo criterio que /{campaign_id}/metrics), no
      el contador crudo Audit.viewed_count (que no dedupe vistas repetidas
      del mismo link).
    - by_cta: agregado SOLO sobre BASIC. Las auditorías PREMIUM heredan un
      cta_variant por default de columna que nunca se setea explícitamente
      (ver audits.py:generate_premium_for_campaign) y no representa una
      decisión real de CTA -- mezclarlo con BASIC ensuciaría la comparación.
    - campaigns: tabla por campaña con leads_count + funnel BASIC/PREMIUM
      individual. Sin límite/offset: se devuelven TODAS las campañas, igual
      que ya hace GET /campaigns (su hermano, sin paginar) -- a este volumen
      (18 campañas) paginar sería complejidad sin beneficio; si esto crece a
      cientos, ahí sí conviene agregar offset/limit (no se hardcodeó ningún
      límite bajo que trunque silenciosamente el resultado mientras tanto).
    """
    # --- Campañas por estado + total ---
    by_status_rows = db.query(Campaign.status, func.count(Campaign.id)).group_by(Campaign.status).all()
    by_status = {s.value: 0 for s in CampaignStatus}
    for status, count in by_status_rows:
        by_status[status.value] = int(count or 0)
    total_campaigns = sum(by_status.values())

    total_leads_assigned = db.query(func.count(CampaignLead.id)).scalar() or 0

    # --- Funnel agregado GLOBAL por kind (BASIC + PREMIUM en paralelo) ---
    def _funnel_for_kind(kind: AuditKind) -> Dict[str, Any]:
        sent = (
            db.query(func.count(Audit.id))
            .filter(Audit.kind == kind, Audit.disabled.is_(False))
            .scalar() or 0
        )
        viewed = (
            db.query(func.count(func.distinct(AuditView.audit_id)))
            .join(Audit, AuditView.audit_id == Audit.id)
            .filter(Audit.kind == kind, Audit.disabled.is_(False))
            .scalar() or 0
        )
        clicked = (
            db.query(func.count(func.distinct(AuditEvent.audit_id)))
            .join(Audit, AuditEvent.audit_id == Audit.id)
            .filter(Audit.kind == kind, Audit.disabled.is_(False), AuditEvent.event_type == "cta_click")
            .scalar() or 0
        )
        sent, viewed, clicked = int(sent), int(viewed), int(clicked)
        return {
            "sent_count": sent,
            "viewed_count": viewed,
            "cta_clicks": clicked,
            "view_rate": float(viewed) / float(sent) if sent > 0 else 0.0,
            "cta_click_rate": float(clicked) / float(viewed) if viewed > 0 else 0.0,
        }

    funnel = {
        "BASIC": _funnel_for_kind(AuditKind.BASIC),
        "PREMIUM": _funnel_for_kind(AuditKind.PREMIUM),
    }

    # --- Desglose agregado por CTA (solo BASIC, ver docstring) ---
    by_cta: Dict[str, Dict[str, Any]] = {}

    rows_totals = (
        db.query(Audit.cta_variant, func.count(Audit.id))
        .filter(Audit.kind == AuditKind.BASIC, Audit.disabled.is_(False))
        .group_by(Audit.cta_variant)
        .all()
    )
    for cta_raw, cnt in rows_totals:
        by_cta.setdefault(_cta_key(cta_raw), {"total": 0, "opened": 0, "clicked": 0})["total"] += int(cnt or 0)

    rows_views = (
        db.query(Audit.cta_variant, func.count(func.distinct(AuditView.audit_id)))
        .join(AuditView, AuditView.audit_id == Audit.id)
        .filter(Audit.kind == AuditKind.BASIC, Audit.disabled.is_(False))
        .group_by(Audit.cta_variant)
        .all()
    )
    for cta_raw, cnt in rows_views:
        by_cta.setdefault(_cta_key(cta_raw), {"total": 0, "opened": 0, "clicked": 0})["opened"] += int(cnt or 0)

    rows_clicks = (
        db.query(Audit.cta_variant, func.count(func.distinct(AuditEvent.audit_id)))
        .join(AuditEvent, AuditEvent.audit_id == Audit.id)
        .filter(Audit.kind == AuditKind.BASIC, Audit.disabled.is_(False), AuditEvent.event_type == "cta_click")
        .group_by(Audit.cta_variant)
        .all()
    )
    for cta_raw, cnt in rows_clicks:
        by_cta.setdefault(_cta_key(cta_raw), {"total": 0, "opened": 0, "clicked": 0})["clicked"] += int(cnt or 0)

    for d in by_cta.values():
        total_c, opened_c, clicked_c = int(d["total"]), int(d["opened"]), int(d["clicked"])
        d["open_rate"] = float(opened_c) / float(total_c) if total_c > 0 else 0.0
        d["click_rate"] = float(clicked_c) / float(opened_c) if opened_c > 0 else 0.0

    # --- Tabla por campaña: leads_count + funnel BASIC/PREMIUM individual ---
    empty_funnel = {"sent_count": 0, "viewed_count": 0, "cta_clicks": 0, "view_rate": 0.0, "cta_click_rate": 0.0}
    per_campaign: Dict[int, Dict[str, Any]] = {
        c.id: {
            "id": c.id,
            "name": c.name,
            "status": c.status.value,
            "leads_count": 0,
            "basic": dict(empty_funnel),
            "premium": dict(empty_funnel),
        }
        for c in db.query(Campaign.id, Campaign.name, Campaign.status).all()
    }

    for cid, cnt in (
        db.query(CampaignLead.campaign_id, func.count(CampaignLead.id))
        .group_by(CampaignLead.campaign_id)
        .all()
    ):
        if cid in per_campaign:
            per_campaign[cid]["leads_count"] = int(cnt or 0)

    def _fill_kind(kind: AuditKind, key: str) -> None:
        sent_rows = (
            db.query(Audit.campaign_id, func.count(Audit.id))
            .filter(Audit.kind == kind, Audit.disabled.is_(False), Audit.campaign_id.isnot(None))
            .group_by(Audit.campaign_id)
            .all()
        )
        for cid, cnt in sent_rows:
            if cid in per_campaign:
                per_campaign[cid][key]["sent_count"] = int(cnt or 0)

        viewed_rows = (
            db.query(Audit.campaign_id, func.count(func.distinct(AuditView.audit_id)))
            .join(AuditView, AuditView.audit_id == Audit.id)
            .filter(Audit.kind == kind, Audit.disabled.is_(False), Audit.campaign_id.isnot(None))
            .group_by(Audit.campaign_id)
            .all()
        )
        for cid, cnt in viewed_rows:
            if cid in per_campaign:
                per_campaign[cid][key]["viewed_count"] = int(cnt or 0)

        clicked_rows = (
            db.query(Audit.campaign_id, func.count(func.distinct(AuditEvent.audit_id)))
            .join(AuditEvent, AuditEvent.audit_id == Audit.id)
            .filter(
                Audit.kind == kind,
                Audit.disabled.is_(False),
                Audit.campaign_id.isnot(None),
                AuditEvent.event_type == "cta_click",
            )
            .group_by(Audit.campaign_id)
            .all()
        )
        for cid, cnt in clicked_rows:
            if cid in per_campaign:
                per_campaign[cid][key]["cta_clicks"] = int(cnt or 0)

        for entry in per_campaign.values():
            d = entry[key]
            d["view_rate"] = float(d["viewed_count"]) / float(d["sent_count"]) if d["sent_count"] > 0 else 0.0
            d["cta_click_rate"] = float(d["cta_clicks"]) / float(d["viewed_count"]) if d["viewed_count"] > 0 else 0.0

    _fill_kind(AuditKind.BASIC, "basic")
    _fill_kind(AuditKind.PREMIUM, "premium")

    campaigns_list = sorted(per_campaign.values(), key=lambda x: x["leads_count"], reverse=True)

    return {
        "by_status": by_status,
        "total_campaigns": int(total_campaigns),
        "total_leads_assigned": int(total_leads_assigned),
        "funnel": funnel,
        "by_cta": by_cta,
        "campaigns": campaigns_list,
    }


@router.post("", response_model=CampaignOut)
def create_campaign(payload: CampaignCreate, db: Session = Depends(get_db)):
    # Nombre único (por conveniencia)
    existing = db.query(Campaign).filter(Campaign.name == payload.name).first()
    if existing:
        raise HTTPException(status_code=400, detail="Ya existe una campaña con ese nombre.")

    # Normalizamos la CTA básica recibida
    allowed_ctas = {"whatsapp_premium", "calendar", "whatsapp_direct"}
    cta_basic = (payload.cta_basic_variant or "whatsapp_premium").strip().lower()
    if cta_basic not in allowed_ctas:
        cta_basic = "whatsapp_premium"

    c = Campaign(
        name=payload.name.strip(),
        description=(payload.description or "").strip() or None,
        status=CampaignStatus.PLANEACION,
        cta_basic_variant=cta_basic,
    )
    db.add(c)
    db.commit()
    db.refresh(c)

    # Al crear una campaña NO agregamos leads aquí, por eso 0.
    return CampaignOut(
        id=c.id,
        name=c.name,
        status=c.status,
        description=c.description,
        cta_basic_variant=c.cta_basic_variant,
        created_at=c.created_at,
        updated_at=c.updated_at,
        leads_count=0,
    )


@router.get("/{campaign_id}/metrics")
def campaign_detail_metrics(campaign_id: int, db: Session = Depends(get_db)):
    """
    Métricas de una campaña:
      - Totales de leads / análisis (scraper)
      - Funnel de auditorías BASIC (enviadas, vistas, clic CTA)
      - Desglose por variante de CTA.
    """
    # Verificamos que exista la campaña (para que si no existe falle arriba)
    exists_campaign = db.query(Campaign.id).filter(Campaign.id == campaign_id).first()
    if not exists_campaign:
        raise HTTPException(status_code=404, detail="Campaña no encontrada.")

    # ====== Bloque original: métricas de leads / scraper ======

    # último SR por place_id
    latest_sub = (
        db.query(func.max(ScraperResult.id).label("id"))
        .filter(ScraperResult.place_id.isnot(None))
        .group_by(ScraperResult.place_id)
        .subquery()
    )

    base = (
        db.query(ScraperResult)
        .join(latest_sub, ScraperResult.id == latest_sub.c.id)
        .join(CampaignLead, CampaignLead.place_id == ScraperResult.place_id)
        .filter(CampaignLead.campaign_id == campaign_id)
    )

    total = base.count()
    with_web = base.filter(ScraperResult.website.isnot(None)).count()
    without_web = total - with_web
    in_zone = base.filter(ScraperResult.in_zone.is_(True)).count()
    out_zone = total - in_zone

    # LeadAnalysis por place_id (usa join por place_id, no por id)
    analyzed = (
        db.query(func.count(LeadAnalysis.id))
        .join(CampaignLead, CampaignLead.place_id == LeadAnalysis.place_id)
        .filter(CampaignLead.campaign_id == campaign_id)
        .scalar()
        or 0
    )

    # top queries (sobre últimos snapshots para evitar duplicados)
    by_query_rows = (
        db.query(ScraperResult.query, func.count(ScraperResult.place_id))
        .join(latest_sub, ScraperResult.id == latest_sub.c.id)
        .join(CampaignLead, CampaignLead.place_id == ScraperResult.place_id)
        .filter(CampaignLead.campaign_id == campaign_id)
        .group_by(ScraperResult.query)
        .order_by(func.count(ScraperResult.place_id).desc())
        .limit(6)
        .all()
    )
    by_query = [{"query": q or "", "count": int(c)} for q, c in by_query_rows]

    # ====== NUEVO: Métricas de auditorías BASIC / CTA ======

    # Auditorías BASIC asociadas a la campaña (no deshabilitadas)
    basic_audits_base = (
        db.query(Audit.id, Audit.cta_variant)
        .filter(
            Audit.campaign_id == campaign_id,
            Audit.kind == AuditKind.BASIC,
            Audit.disabled.is_(False),
        )
    )

    total_basic_audits = basic_audits_base.count()

    # Nº de auditorías BASIC con al menos 1 vista
    basic_opened = (
        db.query(func.count(func.distinct(AuditView.audit_id)))
        .join(Audit, AuditView.audit_id == Audit.id)
        .filter(
            Audit.campaign_id == campaign_id,
            Audit.kind == AuditKind.BASIC,
            Audit.disabled.is_(False),
        )
        .scalar()
        or 0
    )

    # Nº de auditorías BASIC con al menos 1 clic en CTA
    basic_clicked = (
        db.query(func.count(func.distinct(AuditEvent.audit_id)))
        .join(Audit, AuditEvent.audit_id == Audit.id)
        .filter(
            Audit.campaign_id == campaign_id,
            Audit.kind == AuditKind.BASIC,
            Audit.disabled.is_(False),
            AuditEvent.event_type == "cta_click",
        )
        .scalar()
        or 0
    )

    # Ratios (0.0–1.0)
    open_rate_basic = float(basic_opened) / float(total_basic_audits) if total_basic_audits > 0 else 0.0
    click_rate_basic = float(basic_clicked) / float(basic_opened) if basic_opened > 0 else 0.0

    # --- Desglose por CTA (BASIC) ---
    by_cta: Dict[str, Dict[str, Any]] = {}

    # Totales por CTA
    rows_totals = (
        db.query(Audit.cta_variant, func.count(Audit.id))
        .filter(
            Audit.campaign_id == campaign_id,
            Audit.kind == AuditKind.BASIC,
            Audit.disabled.is_(False),
        )
        .group_by(Audit.cta_variant)
        .all()
    )
    for cta_raw, cnt in rows_totals:
        key = _cta_key(cta_raw)
        d = by_cta.setdefault(key, {"total": 0, "opened": 0, "clicked": 0})
        d["total"] += int(cnt or 0)

    # Vistas por CTA (auditorías BASIC con al menos 1 view)
    rows_views = (
        db.query(Audit.cta_variant, func.count(func.distinct(AuditView.audit_id)))
        .join(Audit, AuditView.audit_id == Audit.id)
        .filter(
            Audit.campaign_id == campaign_id,
            Audit.kind == AuditKind.BASIC,
            Audit.disabled.is_(False),
        )
        .group_by(Audit.cta_variant)
        .all()
    )
    for cta_raw, cnt in rows_views:
        key = _cta_key(cta_raw)
        d = by_cta.setdefault(key, {"total": 0, "opened": 0, "clicked": 0})
        d["opened"] += int(cnt or 0)

    # Clics por CTA (auditorías BASIC con al menos 1 cta_click)
    rows_clicks = (
        db.query(Audit.cta_variant, func.count(func.distinct(AuditEvent.audit_id)))
        .join(Audit, AuditEvent.audit_id == Audit.id)
        .filter(
            Audit.campaign_id == campaign_id,
            Audit.kind == AuditKind.BASIC,
            Audit.disabled.is_(False),
            AuditEvent.event_type == "cta_click",
        )
        .group_by(Audit.cta_variant)
        .all()
    )
    for cta_raw, cnt in rows_clicks:
        key = _cta_key(cta_raw)
        d = by_cta.setdefault(key, {"total": 0, "opened": 0, "clicked": 0})
        d["clicked"] += int(cnt or 0)

    # Ratios por CTA
    for key, d in by_cta.items():
        total_c = int(d.get("total") or 0)
        opened_c = int(d.get("opened") or 0)
        clicked_c = int(d.get("clicked") or 0)
        d["open_rate"] = float(opened_c) / float(total_c) if total_c > 0 else 0.0
        d["click_rate"] = float(clicked_c) / float(opened_c) if opened_c > 0 else 0.0

    audits_basic_stats = {
        "sent_count": int(total_basic_audits),
        "viewed_count": int(basic_opened),
        "cta_clicks": int(basic_clicked),
        "view_rate": open_rate_basic,
        "cta_click_rate": click_rate_basic,
        "by_cta": by_cta,
    }

    return {
        "total_leads": total,
        "analyzed_count": analyzed,
        "in_zone_count": in_zone,
        "out_zone_count": out_zone,
        "with_website_count": with_web,
        "without_website_count": without_web,
        "by_query": by_query,
        # NUEVO: funnel de auditorías básicas
        "audits_basic": audits_basic_stats,
    }


@router.get("/{campaign_id}", response_model=CampaignOut)
def get_campaign(campaign_id: int, db: Session = Depends(get_db)):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(status_code=404, detail="Campaña no encontrada.")
    return _campaign_out_with_counts(db, c)


@router.patch("/{campaign_id}", response_model=CampaignOut)
def update_campaign(campaign_id: int, payload: CampaignUpdate, db: Session = Depends(get_db)):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(status_code=404, detail="Campaña no encontrada.")

    if payload.name is not None:
        name = payload.name.strip()
        if name != c.name:
            clash = db.query(Campaign).filter(Campaign.name == name).first()
            if clash:
                raise HTTPException(status_code=400, detail="Ya existe otra campaña con ese nombre.")
            c.name = name

    if payload.description is not None:
        c.description = payload.description.strip() or None

    if payload.status is not None:
        c.status = payload.status

    # Permitir cambiar la CTA básica de la campaña (afecta nuevas auditorías)
    if payload.cta_basic_variant is not None:
        allowed_ctas = {"whatsapp_premium", "calendar", "whatsapp_direct"}
        raw = (payload.cta_basic_variant or "").strip().lower()
        if raw not in allowed_ctas:
            raw = "whatsapp_premium"
        c.cta_basic_variant = raw

    db.add(c)
    db.commit()
    db.refresh(c)
    return _campaign_out_with_counts(db, c)


@router.delete("/{campaign_id}")
def delete_campaign(campaign_id: int, db: Session = Depends(get_db)):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(status_code=404, detail="Campaña no encontrada.")

    try:
        audit_ids = [
            aid for (aid,) in db.query(Audit.id).filter(Audit.campaign_id == campaign_id).all()
        ]

        if audit_ids:
            db.query(AuditEvent).filter(AuditEvent.audit_id.in_(audit_ids)).delete(synchronize_session=False)
            db.query(AuditView).filter(AuditView.audit_id.in_(audit_ids)).delete(synchronize_session=False)
            db.query(Audit).filter(Audit.id.in_(audit_ids)).delete(synchronize_session=False)

        db.query(CampaignLead).filter(CampaignLead.campaign_id == campaign_id).delete(synchronize_session=False)

        db.delete(c)
        db.commit()
        return {"ok": True}

    except Exception:
        db.rollback()
        raise



@router.post("/{campaign_id}/leads")
def add_leads_to_campaign(campaign_id: int, body: LeadIdsIn, db: Session = Depends(get_db)):
    c = db.get(Campaign, campaign_id)
    if not c:
        raise HTTPException(status_code=404, detail="Campaña no encontrada.")
    if c.status == CampaignStatus.FINALIZADA:
        raise HTTPException(status_code=400, detail="No se puede agregar leads a una campaña FINALIZADA.")

    place_ids = list(dict.fromkeys([pid.strip() for pid in body.place_ids if pid and pid.strip()]))
    if not place_ids:
        return {"requested": 0, "added": 0, "skipped": 0}

    requested = len(place_ids)
    added = 0

    if _is_mysql(db):
        # INSERT IGNORE respeta UniqueConstraint(place_id)
        stmt = mysql_insert(CampaignLead).values(
            [{"campaign_id": campaign_id, "place_id": pid} for pid in place_ids]
        ).prefix_with("IGNORE")
        res = db.execute(stmt)
        db.commit()
        added = res.rowcount or 0
    else:
        # Fallback portable
        for pid in place_ids:
            try:
                db.add(CampaignLead(campaign_id=campaign_id, place_id=pid))
                db.commit()
                added += 1
            except IntegrityError:
                db.rollback()
                continue

    skipped = requested - added
    return {"requested": requested, "added": added, "skipped": skipped}


# Alias de compatibilidad con el frontend actual:
# Permite llamar a POST /campaigns/{id}/add_leads (equivalente a POST /campaigns/{id}/leads)
@router.post("/{campaign_id}/add_leads")
def add_leads_to_campaign_alias(campaign_id: int, body: LeadIdsIn, db: Session = Depends(get_db)):
    return add_leads_to_campaign(campaign_id, body, db)


@router.delete("/{campaign_id}/leads")
def remove_leads_from_campaign(campaign_id: int, body: LeadIdsIn, db: Session = Depends(get_db)):
    # Elimina SOLO si pertenecen a esta campaña
    q = db.query(CampaignLead).filter(
        CampaignLead.campaign_id == campaign_id,
        CampaignLead.place_id.in_(body.place_ids),
    )
    removed = q.delete(synchronize_session=False)
    db.commit()
    return {"requested": len(body.place_ids), "removed": removed}


@router.get("/{campaign_id}/leads")
def list_campaign_leads(
    campaign_id: int,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    """
    Devuelve los leads de la campaña con datos mínimos para la UI (checkboxes):
    - place_id
    - name
    - city
    - website

    Mantiene paginación por offset/limit.
    Siempre devuelve solo la ÚLTIMA versión (ScraperResult) por place_id.
    """
    exists_campaign = db.query(Campaign.id).filter(Campaign.id == campaign_id).first()
    if not exists_campaign:
        raise HTTPException(status_code=404, detail="Campaña no encontrada.")

    # Subquery: último ScraperResult por place_id (1 fila por negocio)
    latest_sub = (
        db.query(
            func.max(ScraperResult.id).label("id"),
            ScraperResult.place_id.label("place_id"),
        )
        .filter(ScraperResult.place_id.isnot(None))
        .group_by(ScraperResult.place_id)
        .subquery()
    )

    rows = (
        db.query(
            CampaignLead.place_id.label("place_id"),
            ScraperResult.name.label("name"),
            ScraperResult.city.label("city"),
            ScraperResult.website.label("website"),
        )
        .select_from(CampaignLead)
        .outerjoin(latest_sub, latest_sub.c.place_id == CampaignLead.place_id)
        .outerjoin(ScraperResult, ScraperResult.id == latest_sub.c.id)
        .filter(CampaignLead.campaign_id == campaign_id)
        .order_by(CampaignLead.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    items = [
        {
            "place_id": r.place_id,
            "name": r.name,
            "city": r.city,
            "website": r.website,
        }
        for r in rows
    ]
    return {"items": items, "offset": offset, "limit": limit}



# -----------------------------
# Outreach: mensajes para export CSV (sin LLM, heurística + plantillas)
# -----------------------------

AUDIT_HOST = os.getenv("AUDIT_HOST", "https://audit.pixelfluxcreative.com").rstrip("/")

TEMPLATES_V1 = [
    # 1) Direct, with a hook
    "Hi {name} 👋 I noticed you don't have a website yet, and that's costing you customers today (people search and go with whoever shows up first).\n"
    "I put together a FREE digital audit so you can see it in 2 min: {audit_url}",

    "Hi {name}! 🙌 I saw you don't have a website yet, and you're missing searches every single day because of it.\n"
    "Check out your free audit here (quick and clear): {audit_url}",

    # 2) Curiosity + "might surprise you"
    "Hi {name} 👋 I put together a free digital audit for you, and there are a couple of details that might surprise you (small, but they move the needle).\n"
    "Here it is: {audit_url}",

    "Hi {name}! 🙌 I reviewed your online presence and found 2 opportunities that could bring you more customers without doing anything crazy.\n"
    "The audit is ready: {audit_url}",

    # 3) "Google is costing you sales" (no niche/geo mentions)
    "Hi {name} 👋 When someone looks you up on Google, if you don't have a website they often go with someone else who looks more established.\n"
    "Here's your free audit so you can see it: {audit_url}",

    "Hi {name}! 🙌 Most people decide based on Google these days. No website means lost trust and clicks (and those clicks are sales).\n"
    "Your free digital audit is here: {audit_url}",

    # 6) Warmer, more casual
    "Hey {name} 👋 Found you and got hungry just looking, haha 😄 Noticed you don't have a website yet, and that hurts your visibility when people are out there looking for where to buy.\n"
    "Left you a quick free audit: {audit_url}",

    "Hi {name}! 🙌 Noticed you still don't have a website, and with how competitive things are, that costs you customers even if your product is great.\n"
    "Check out the free audit here: {audit_url}",

    # 7) Question hook / gentle pressure
    "Hi {name} 👋 Quick question: did you know you're losing customers because when people search on Google, they go with whoever has a website and shows up first?\n"
    "Left you a free audit so you can see it in 2 min: {audit_url}",

    # 8) Competitive angle
    "Hi {name} 👋 Some businesses show up first just because they have a website… and a lot of the time they're not better, just more visible 😅\n"
    "Left you a free audit to help you beat that: {audit_url}",
]


def _stable_templates_for_campaign(campaign_id: int) -> List[str]:
    """
    "Shuffle por campaña" estable: mezcla las plantillas en base al campaign_id
    (determinista, no requiere columna extra en BD).
    """
    ts = list(TEMPLATES_V1)
    random.Random(int(campaign_id)).shuffle(ts)
    return ts


def _pick_template(campaign_id: int, place_id: str, reviews_count: Optional[int]) -> str:
    """
    Heurística simple:
    - Si tiene muchas reseñas, usar más seguido templates de presión/competencia.
    - Si no, usar el set general.
    Además, selección estable por lead.
    """
    ts = _stable_templates_for_campaign(campaign_id)
    rc = int(reviews_count or 0)

    if rc >= 50:
        preferred_idxs = [len(ts) - 2, len(ts) - 1]  # pregunta + competencia (según el shuffle)
    else:
        preferred_idxs = list(range(0, min(8, len(ts))))  # primeras 8 del shuffle

    # Selección estable por hash
    h = hashlib.sha256(f"{campaign_id}:{place_id}".encode("utf-8")).digest()
    idx = preferred_idxs[h[0] % len(preferred_idxs)]
    return ts[idx]


def _render_message(template: str, name: Optional[str], audit_url: str) -> str:
    safe_name = (name or "").strip() or "there"
    return (
        template.replace("{name}", safe_name)
        .replace("{nombre}", safe_name)  # tolerancia por si aparece
        .replace("{audit_url}", audit_url)
        .replace("{LINK}", audit_url)
    )


class MessageUpdateIn(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)


@router.post("/{campaign_id}/messages/generate")
def generate_messages_for_campaign(
    campaign_id: int,
    mode: str = Query("selected", description="selected|all"),
    overwrite: bool = Query(False, description="Si true, sobrescribe incluso manual/ya existente"),
    payload: Optional[LeadIdsIn] = None,
    db: Session = Depends(get_db),
):
    """
    Genera mensajes (plantillas + heurística) y los guarda en CampaignLead.message.

    Reglas V1:
    - Solo si hay auditoría BASIC activa (más reciente) para ese lead en la campaña.
    - Solo si hay phone.
    - Placeholders usados: {name}, {audit_url}.
    - Shuffle estable por campaña.
    """
    camp = db.get(Campaign, campaign_id)
    if not camp:
        raise HTTPException(status_code=404, detail="No existe la campaña")

    # Determinar place_ids objetivo
    if mode == "all":
        place_ids = [
            pid
            for (pid,) in db.query(CampaignLead.place_id)
            .filter(CampaignLead.campaign_id == campaign_id)
            .all()
        ]
    else:
        if not payload or not payload.place_ids:
            raise HTTPException(status_code=400, detail="place_ids requerido para mode=selected")
        place_ids = list(dict.fromkeys(payload.place_ids))  # unique preservando orden

    if not place_ids:
        return {"ok": True, "generated": 0, "skipped": 0, "skipped_reasons": {}, "updated_place_ids": []}

    now = datetime.utcnow()

    # Auditorías BASIC activas (más reciente por place_id)
    base_basic = f"{AUDIT_HOST}/a/"
    audits = (
        db.query(Audit)
        .filter(
            Audit.campaign_id == campaign_id,
            Audit.kind == AuditKind.BASIC,
            Audit.disabled.is_(False),
            Audit.expires_at > now,
            Audit.place_id.in_(place_ids),
        )
        .order_by(Audit.created_at.desc())
        .all()
    )
    audit_url_by_place: Dict[str, str] = {}
    for a in audits:
        if a.place_id not in audit_url_by_place:
            audit_url_by_place[a.place_id] = base_basic + a.token

    # Último ScraperResult por place_id para obtener phone/name/reviews_count
    latest_sub = (
        db.query(func.max(ScraperResult.id).label("id"), ScraperResult.place_id.label("place_id"))
        .filter(ScraperResult.place_id.in_(place_ids))
        .group_by(ScraperResult.place_id)
        .subquery()
    )
    lead_rows = (
        db.query(
            ScraperResult.place_id,
            ScraperResult.name,
            ScraperResult.phone,
            ScraperResult.reviews_count,
        )
        .join(latest_sub, latest_sub.c.id == ScraperResult.id)
        .all()
    )
    lead_info = {r.place_id: r for r in lead_rows}

    # CampaignLead rows
    cls = (
        db.query(CampaignLead)
        .filter(CampaignLead.campaign_id == campaign_id, CampaignLead.place_id.in_(place_ids))
        .all()
    )
    cl_by_place = {cl.place_id: cl for cl in cls}

    updated: List[str] = []
    skipped_reasons: Dict[str, int] = {
        "no_audit": 0,
        "no_phone": 0,
        "missing_campaign_lead": 0,
        "already_has_message": 0,
        "manual_locked": 0,
    }

    for pid in place_ids:
        cl = cl_by_place.get(pid)
        if not cl:
            skipped_reasons["missing_campaign_lead"] += 1
            continue

        audit_url = audit_url_by_place.get(pid)
        if not audit_url:
            skipped_reasons["no_audit"] += 1
            continue

        info = lead_info.get(pid)
        phone = (getattr(info, "phone", None) or "").strip() if info else ""
        if not phone:
            skipped_reasons["no_phone"] += 1
            continue

        # overwrite policy
        if cl.message and str(cl.message).strip():
            if not overwrite:
                # si fue manual, lo consideramos "lock"
                if (cl.message_source or "").lower() == "manual":
                    skipped_reasons["manual_locked"] += 1
                else:
                    skipped_reasons["already_has_message"] += 1
                continue

        tpl = _pick_template(campaign_id, pid, getattr(info, "reviews_count", 0) if info else 0)
        msg = _render_message(tpl, getattr(info, "name", None) if info else None, audit_url)

        cl.message = msg
        cl.message_source = "generated"
        cl.message_updated_at = now
        updated.append(pid)

    if updated:
        db.add_all([cl_by_place[pid] for pid in updated if pid in cl_by_place])
        db.commit()

    generated = len(updated)
    skipped = len(place_ids) - generated
    skipped_reasons = {k: v for k, v in skipped_reasons.items() if v}

    return {
        "ok": True,
        "generated": generated,
        "skipped": skipped,
        "skipped_reasons": skipped_reasons,
        "updated_place_ids": updated,
    }


@router.patch("/{campaign_id}/messages/{place_id}")
def update_campaign_lead_message(
    campaign_id: int,
    place_id: str,
    payload: MessageUpdateIn,
    db: Session = Depends(get_db),
):
    cl = (
        db.query(CampaignLead)
        .filter(CampaignLead.campaign_id == campaign_id, CampaignLead.place_id == place_id)
        .first()
    )
    if not cl:
        raise HTTPException(status_code=404, detail="Lead no existe en esta campaña")

    cl.message = payload.message.strip()
    cl.message_source = "manual"
    cl.message_updated_at = datetime.utcnow()
    db.add(cl)
    db.commit()
    return {"ok": True}

