import enum
from sqlalchemy import (
    Column,
    Integer,
    String,
    DateTime,
    func,
    BigInteger,
    Text,
    Enum,
    ForeignKey,
    Numeric,
    Float,
    UniqueConstraint,
    Index,
    Boolean,
    Enum as SAEnum,
)

from .db import Base
from sqlalchemy.orm import relationship
from datetime import datetime
from app.db import Base


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String(191), unique=True, index=True, nullable=False)
    name = Column(String(191), nullable=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(32), default="admin")
    created_at = Column(DateTime, server_default=func.now())


class Contact(Base):
    __tablename__ = "contacts"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    wa_id = Column(String(32), unique=True, nullable=False)
    profile_name = Column(String(191))
    phone = Column(String(32))
    last_message_at = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)

    messages = relationship("Message", back_populates="contact", cascade="all, delete-orphan")


class Message(Base):
    __tablename__ = "messages"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    contact_id = Column(BigInteger, ForeignKey("contacts.id"), nullable=False)
    wa_id = Column(String(32), nullable=False)
    wamid = Column(String(100), unique=True, nullable=False)
    # coincide con ENUM('in','out') de MariaDB
    direction = Column(Enum("in", "out", name="direction_enum"), nullable=False)
    mtype = Column(String(24), nullable=False)  # text|template|media|...
    text = Column(Text)
    template_name = Column(String(128))
    media_url = Column(Text)
    media_mime = Column(String(128))
    ts = Column(DateTime, nullable=False)
    status = Column(String(24))
    created_at = Column(DateTime, default=datetime.utcnow)

    contact = relationship("Contact", back_populates="messages")


# --- SCRAPER TABLES ---

class ScraperRun(Base):
    __tablename__ = "scraper_runs"

    id = Column(Integer, primary_key=True)
    status = Column(String(20), nullable=False, default="pending")

    # cuándo arrancó realmente el run
    started_at = Column(DateTime, nullable=True)

    # cuántos ítems procesados (para feedback de progreso en UI)
    progress = Column(Integer, nullable=False, default=0)

    # opciones avanzadas usadas en este job (JSON serializado)
    opts_json = Column(Text, nullable=True)

    # NUEVOS CAMPOS
    total = Column(Integer, nullable=False, default=0)
    ok = Column(Integer, nullable=False, default=0)
    error = Column(Integer, nullable=False, default=0)
    status_msg = Column(String(500))

    created_at = Column(DateTime, server_default=func.now())
    finished_at = Column(DateTime, nullable=True)

    # Observabilidad de scroll/extracción del scraper (ver CONTEXT_MAP.md §11
    # ítem 11): permiten distinguir "Google mostró pocos resultados" de "el
    # código perdió resultados que sí estaban disponibles".
    cards_seen = Column(Integer, nullable=False, default=0)             # tarjetas vistas en el feed (todas las queries del run)
    extraction_attempted = Column(Integer, nullable=False, default=0)   # tarjetas en que se intentó click+extracción
    extraction_ok = Column(Integer, nullable=False, default=0)          # extracciones exitosas (yield en iter_scraper_results)
    extraction_failed = Column(Integer, nullable=False, default=0)      # intentos fallidos (excepción o sin place_id)
    extraction_fail_reasons = Column(Text, nullable=True)               # JSON {motivo: cantidad}, agrupado


class ScraperResult(Base):
    __tablename__ = "scraper_results"
    __table_args__ = (
        UniqueConstraint("run_id", "place_id", name="uq_scraper_results_run_place"),
        # (opcional) si quieres acelerar búsquedas por teléfono:
        # Index("ix_scraper_results_phone_combo", "phone_e164", "phone_raw"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(
        Integer,
        ForeignKey("scraper_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source = Column(String(20), nullable=False, default="gmaps")
    place_id = Column(String(128), nullable=False, index=True)   # ← NOT NULL
    name = Column(String(255))
    category = Column(String(255))
    phone_raw = Column(String(64))
    phone_e164 = Column(String(32), index=True)
    email = Column(String(255))
    website = Column(String(1024), nullable=True)
    address = Column(String(500), nullable=True)
    city = Column(String(128))
    region = Column(String(128))
    country = Column(String(64))
    lat = Column(Numeric(10, 7))
    lng = Column(Numeric(10, 7))
    rating = Column(Numeric(3, 2))
    review_count = Column(Integer)
    maps_url = Column(Text, nullable=True)
    raw_json = Column(Text)
    first_seen_at = Column(DateTime, server_default=func.now())
    last_seen_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    query = Column(String(255), nullable=True)
    query_group = Column(String(255), index=True, nullable=True)
    phone = Column(String(64))
    in_zone = Column(Boolean, nullable=True, default=False)  # True=En zona, False=Fuera de zona, None=zona no confiable (ver zone_reliable en runner.py)
    zone_name = Column(String(128))                           # p.ej. "Vicuña (CL)"
    zone_center_lat = Column(Numeric(10, 7))
    zone_center_lng = Column(Numeric(10, 7))
    zone_radius_km = Column(Float)
    # Origen del centro de zona usado para calcular in_zone (ver CONTEXT_MAP.md §2.5/§11):
    #   live_coords    -> Google devolvió @lat,lng real en la URL de resultados
    #   retro_centroid -> in_zone recalculado retroactivamente (backfill) con el
    #                     centroide de las coordenadas propias del grupo (run_id, query)
    #   unknown        -> no se pudo calcular con confianza; in_zone queda NULL
    zone_source = Column(
        Enum("live_coords", "retro_centroid", "unknown", name="zone_source_enum"),
        nullable=True,
    )
    # Nº de reseñas capturadas para este negocio en este run
    reviews_count = Column(Integer, nullable=False, default=0)
    # Nº de reseñas que, además, tienen respuesta del negocio
    owner_responses_count = Column(Integer, nullable=False, default=0)


class ScraperReview(Base):
    __tablename__ = "scraper_reviews"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(Integer, ForeignKey("scraper_runs.id", ondelete="CASCADE"), nullable=False, index=True)
    result_id = Column(Integer, ForeignKey("scraper_results.id", ondelete="CASCADE"), nullable=False, index=True)
    place_id = Column(String(128), index=True)
    review_id = Column(String(128))
    author = Column(String(255))
    rating = Column(Integer)
    text = Column(Text)
    published_at = Column(DateTime)
    lang = Column(String(16))
    raw_json = Column(Text)


class LeadAnalysis(Base):
    __tablename__ = "lead_analysis"

    id = Column(Integer, primary_key=True, autoincrement=True)

    # Clave lógica del negocio (1 análisis vigente por place_id)
    place_id = Column(String(128), nullable=False, unique=True, index=True)

    # (Opcional) referencia al último resultado usado para el análisis
    result_id = Column(Integer, ForeignKey("scraper_results.id", ondelete="SET NULL"), nullable=True, index=True)

    # Heurística (persistente) — OPORTUNIDAD (ya existente)
    website_exists = Column(Boolean, nullable=False, default=False)
    http_status = Column(Integer, nullable=True)
    https_enabled = Column(Boolean, nullable=False, default=False)
    has_mailto = Column(Boolean, nullable=False, default=False)
    has_whatsapp = Column(Boolean, nullable=False, default=False)
    has_social = Column(Boolean, nullable=False, default=False)
    score = Column(Integer, nullable=False, default=0)  # ← Oportunidad (se mantiene)
    issues_json = Column(Text, nullable=True)           # lista/objeto JSON (texto)

    # === NUEVO: Clasificación de "web" + Intención + Prioridad ===
    # website_type: OWN_SITE | SOCIAL | LINK_HUB | MENU_QR | MARKETPLACE | PLATFORM_SUBDOMAIN | NONE
    website_type = Column(
        Enum(
            "OWN_SITE",
            "SOCIAL",
            "LINK_HUB",
            "MENU_QR",
            "MARKETPLACE",
            "PLATFORM_SUBDOMAIN",
            "NONE",
            name="website_type_enum",
        ),
        nullable=False,
        default="NONE",
    )
    # proveedor detectado (ej: instagram, linktr.ee, fu.do, choiceqr, wixsite, etc.)
    website_provider = Column(String(128), nullable=True)
    # dominio raíz (eTLD+1) detectado (ej: alforno.cl, choiceqr.com)
    website_root_domain = Column(String(191), nullable=True)

    # Intención (0–100) — señales de que “quieren algo digital”
    intention_score = Column(Integer, nullable=False, default=0)

    # Prioridad (0–100) — combinación de oportunidad + intención para ordenar
    priority_score = Column(Integer, nullable=False, default=0)

    # AI (persistente)
    ai_pitch = Column(Text, nullable=True)            # copy en TU voz (para vender)
    ai_checklist = Column(Text, nullable=True)        # array JSON (bullets para ti)
    model_name = Column(String(64), nullable=True)
    tokens_prompt = Column(Integer, nullable=False, default=0)
    tokens_completion = Column(Integer, nullable=False, default=0)
    cost_usd = Column(Numeric(10, 4), nullable=False, default=0)

    # Contexto / Control
    source_job_id = Column(Integer, nullable=True)    # job del que salió el dato (opcional)
    campaign_id = Column(String(64), nullable=True)   # si quieres variar el pitch por campaña
    last_checked_at = Column(DateTime, server_default=func.now(), nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, onupdate=func.now())

    waf_restricted = Column(Boolean, default=False, nullable=True)
    last_http_variant = Column(String(255), nullable=True)  # p.ej. "https://www.dominio.cl/"
    last_http_method = Column(String(16), nullable=True)   # "HEAD" | "GET"
    last_fetch_reason = Column(String(255), nullable=True)  # breve motivo/resultado

    # === Ciclo de vida del lead (ver CONTEXT_MAP.md §9.1) ===
    # 'active' (default) -> 'possibly_closed' tras N ausencias consecutivas en
    # corridas posteriores de la misma query (ver runner.py:_detect_possible_closures).
    # 'confirmed_closed' NO se dispara automaticamente hoy -- queda como valor
    # valido para uso manual futuro (no existe señal de "cerrado" capturable
    # de forma confiable desde el DOM con el patron de busqueda por categoria
    # de este sistema, ver §2.3/§9.1).
    lead_status = Column(
        Enum("active", "possibly_closed", "confirmed_closed", name="lead_status_enum"),
        nullable=False,
        default="active",
    )
    possibly_closed_since = Column(DateTime, nullable=True)  # se setea al pasar a possibly_closed, se limpia al volver a active
    consecutive_absences = Column(Integer, nullable=False, default=0)  # corridas consecutivas de la misma query sin ver este place_id
    # Deliberadamente NO usa scraper_results.last_seen_at (contaminado por
    # ON UPDATE CURRENT_TIMESTAMP ante cualquier UPDATE no relacionado, ver
    # CONTEXT_MAP.md §9.1) -- este campo solo lo actualiza
    # _detect_possible_closures cuando confirma presencia real en una corrida.
    last_confirmed_seen_run_id = Column(Integer, nullable=True)


class CampaignStatus(enum.Enum):
    PLANEACION = "PLANEACION"
    ACTIVA = "ACTIVA"
    DETENIDA = "DETENIDA"
    FINALIZADA = "FINALIZADA"


class Campaign(Base):
    __tablename__ = "campaigns"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(191), unique=True, index=True, nullable=False)
    status = Column(Enum(CampaignStatus), nullable=False, default=CampaignStatus.PLANEACION)
    description = Column(String(500), nullable=True)

    # CTA por defecto para las auditorías básicas de esta campaña.
    # Valores esperados: "whatsapp_premium" | "calendar" | "whatsapp_direct"
    cta_basic_variant = Column(
        String(32),
        nullable=True,
        default="whatsapp_premium",
    )

    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, onupdate=func.now())

    # Relación con los leads asignados (estática)
    leads = relationship("CampaignLead", back_populates="campaign", cascade="all, delete-orphan")
    # relación inversa en Campaign
    audits = relationship("Audit", back_populates="campaign", cascade="all, delete-orphan")


class CampaignLead(Base):
    """
    Asignación estática de leads a campañas.
    Regla de negocio: un lead (place_id) sólo puede pertenecer a UNA campaña a la vez.
    Lo garantizamos con una restricción de unicidad global sobre place_id.
    """
    __tablename__ = "campaign_leads"
    __table_args__ = (
        UniqueConstraint("place_id", name="uq_campaign_leads_place"),
        Index("ix_campaign_leads_campaign", "campaign_id"),
        Index("ix_campaign_leads_place", "place_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False)
    place_id = Column(String(128), nullable=False)

    # Outreach (mensaje para export CSV / envío externo)
    message = Column(Text, nullable=True)
    message_source = Column(String(20), nullable=True)  # "generated" | "manual"
    message_updated_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    campaign = relationship("Campaign", back_populates="leads")


# 🔹 CTA enum (usar values en minúsculas)
class AuditCTAVariant(str, enum.Enum):
    WHATSAPP_PREMIUM = "whatsapp_premium"
    CALENDAR = "calendar"
    WHATSAPP_DIRECT = "whatsapp_direct"


class AuditKind(enum.Enum):
    BASIC = "BASIC"
    PREMIUM = "PREMIUM"


class Audit(Base):
    __tablename__ = "audits"
    id = Column(Integer, primary_key=True, autoincrement=True)
    token = Column(String(64), unique=True, index=True, nullable=False)
    kind = Column(Enum(AuditKind), nullable=False)
    place_id = Column(String(128), index=True, nullable=False)
    campaign_id = Column(Integer, ForeignKey("campaigns.id", ondelete="SET NULL"), nullable=True, index=True)

    expires_at = Column(DateTime, nullable=False)
    disabled = Column(Boolean, nullable=False, default=False)

    payload_json = Column(Text, nullable=True)
    generated_at = Column(DateTime, nullable=True)

    viewed_count = Column(Integer, nullable=False, default=0)
    last_view_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    campaign = relationship("Campaign", back_populates="audits", lazy="joined")

    # ✅ NUEVO: si se borra una Audit, se borran también sus hijos (no se intenta setear NULL)
    views = relationship("AuditView", back_populates="audit", cascade="all, delete-orphan")
    events = relationship("AuditEvent", back_populates="audit", cascade="all, delete-orphan")

    cta_variant = Column(
        SAEnum(
            AuditCTAVariant,
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
            name="auditctavariant",
        ),
        nullable=True,
        default=AuditCTAVariant.WHATSAPP_PREMIUM,
    )


class AuditView(Base):
    __tablename__ = "audit_views"
    id = Column(Integer, primary_key=True, autoincrement=True)
    audit_id = Column(Integer, ForeignKey("audits.id", ondelete="CASCADE"), index=True, nullable=False)
    ip = Column(String(64))
    ua = Column(String(255))
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # ✅ NUEVO
    audit = relationship("Audit", back_populates="views")


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    audit_id = Column(Integer, ForeignKey("audits.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type = Column(String(32), nullable=False, index=True)
    source = Column(String(32), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # ✅ CAMBIO: fuera backref, usamos back_populates
    audit = relationship("Audit", back_populates="events")
