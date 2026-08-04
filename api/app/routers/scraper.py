import os
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from typing import List, Optional
from sqlalchemy.orm import Session
from datetime import datetime
import json

from app.db import get_db
from app.models import ScraperRun, ScraperResult, ScraperReview

router = APIRouter(prefix="/scraper", tags=["scraper"])

# En el demo público no hay scraper real (sin Selenium/Chromium en la imagen,
# ver README). El resto de la app sigue leyendo los resultados ya sembrados.
DEMO_READONLY = os.getenv("DEMO_READONLY", "true").lower() == "true"

# =========================
# Modelos de creación de job
# =========================

class CreateJobOptions(BaseModel):
    # Opciones avanzadas: aplican a TODAS las queries del job (más adelante podremos personalizar por query)
    radius_km: Optional[float] = Field(default=None, ge=1, le=50, description="Radio AOI en km (auto si None)")
    mode: Optional[str] = Field(default="strict", description="strict | explorer")
    categories: Optional[str] = Field(default="strict", description="strict | extended")
    country: Optional[str] = Field(default="CL", description="Código país (ej: CL, AR, PE, MX)")

class CreateJobPayload(BaseModel):
    queries: List[str]
    options: Optional[CreateJobOptions] = None


# =========================
# Endpoints
# =========================

@router.post("/jobs")
def create_job(payload: CreateJobPayload, db: Session = Depends(get_db)):
    if DEMO_READONLY:
        raise HTTPException(
            status_code=403,
            detail="Modo demo: el scraper real está deshabilitado. Los resultados que ves abajo fueron precargados al construir la demo.",
        )

    queries = [q.strip() for q in (payload.queries or []) if q and q.strip()]
    if not queries:
        raise HTTPException(status_code=400, detail="Debe enviar al menos una consulta.")

    raise HTTPException(status_code=501, detail="Scraper real no disponible en esta imagen.")


@router.get("/jobs")
def list_jobs(db: Session = Depends(get_db)):
    rows = db.query(ScraperRun).order_by(ScraperRun.id.desc()).limit(50).all()
    items = [{
        "id": r.id,
        "status": r.status,
        "created_at": r.created_at,
        "finished_at": r.finished_at,
        "total": r.total,
        "ok": r.ok,
        "error": r.error,
        "status_msg": r.status_msg or "",
        # Observabilidad de scroll/extracción (ver CONTEXT_MAP.md §11 ítem 11):
        # permiten distinguir "Google mostró pocos resultados" de "el código
        # perdió resultados que sí estaban disponibles".
        "cards_seen": r.cards_seen,
        "extraction_attempted": r.extraction_attempted,
        "extraction_ok": r.extraction_ok,
        "extraction_failed": r.extraction_failed,
        "extraction_fail_reasons": json.loads(r.extraction_fail_reasons) if r.extraction_fail_reasons else {},
    } for r in rows]
    return {"items": items}


@router.get("/jobs/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    r = db.query(ScraperRun).get(job_id)
    if not r:
        raise HTTPException(status_code=404, detail="job no encontrado")
    return {
        "id": r.id,
        "status": r.status,
        "created_at": r.created_at,
        "started_at": r.started_at,
        "finished_at": r.finished_at,
        "progress": r.progress,
        "opts": json.loads(r.opts_json) if r.opts_json else None,
        "error_msg": r.status_msg or "",
        "cards_seen": r.cards_seen,
        "extraction_attempted": r.extraction_attempted,
        "extraction_ok": r.extraction_ok,
        "extraction_failed": r.extraction_failed,
        "extraction_fail_reasons": json.loads(r.extraction_fail_reasons) if r.extraction_fail_reasons else {},
    }


@router.get("/jobs/{job_id}/results")
def get_results(job_id: int,
                q: Optional[str] = None,
                in_zone: Optional[bool] = Query(default=None, description="Filtrar por En zona / Fuera de zona"),
                zone: Optional[str] = Query(default=None, description="Filtrar por nombre de zona"),
                offset: int = 0,
                limit: int = 50,
                db: Session = Depends(get_db)):
    base = db.query(ScraperResult).filter(ScraperResult.run_id == job_id)

    if q:
        like = f"%{q}%"
        base = base.filter(
            (ScraperResult.name.like(like)) |
            (ScraperResult.city.like(like)) |
            (ScraperResult.phone_raw.like(like)) |
            (ScraperResult.phone_e164.like(like)) |
            (ScraperResult.address.like(like))
        )

    if in_zone is not None:
        base = base.filter(ScraperResult.in_zone == in_zone)

    if zone:
        base = base.filter(ScraperResult.zone_name == zone)

    total = base.count()
    rows = base.order_by(ScraperResult.id.asc()).offset(offset).limit(limit).all()
    items = [{
        "id": r.id,
        "place_id": r.place_id,
        "name": r.name,
        "category": r.category,
        "phone": r.phone_e164 or r.phone_raw,
        "phone_raw": r.phone_raw,
        "phone_e164": r.phone_e164,
        "city": r.city,
        "region": r.region,
        "country": r.country,
        "rating": float(r.rating) if r.rating is not None else None,
        "reviews": r.review_count,  # cuenta "visibilidad" del rating (si existía antes)
        "reviews_count": r.reviews_count or 0,  # NUEVO: opiniones scrap guardadas
        "owner_responses_count": r.owner_responses_count or 0,  # NUEVO
        "website": r.website,
        "maps_url": r.maps_url,
        "address": r.address,
        "query": r.query,
        # zona
        "in_zone": r.in_zone,  # True/False/None (None = zona no confiable)
        "zone_name": r.zone_name,
        "zone_center_lat": float(r.zone_center_lat) if r.zone_center_lat is not None else None,
        "zone_center_lng": float(r.zone_center_lng) if r.zone_center_lng is not None else None,
        "zone_radius_km": r.zone_radius_km,
    } for r in rows]
    return {"total": total, "items": items}
