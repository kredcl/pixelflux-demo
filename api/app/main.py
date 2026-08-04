import os, requests
import re
from jose import jwt, JWTError

from sqlalchemy.orm import Session

from fastapi import FastAPI, Depends, HTTPException, Response, Request, Body

from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse

from .db import SessionLocal
from .models import User
from .auth import make_token, verify_password

from sqlalchemy import and_

from app.db import get_db as _get_db_imported  # (quedará ocultado por la función local de abajo)
from app.models import Contact, Message

from datetime import datetime, timezone
from typing import Optional, List

app = FastAPI(title="PixelFlux API")

# Routers
from app.routers.leads import router as leads_router
from app.routers.scraper import router as scraper_router
from app.routers.campaigns import router as campaigns_router
from app.routers import audits as audits_router

app.include_router(leads_router)
app.include_router(scraper_router)
app.include_router(campaigns_router)
app.include_router(audits_router.router)


# =========================
# CORS (robusto)
# =========================

def _split_origins(s: Optional[str]) -> List[str]:
    if not s:
        return []
    return [o.strip() for o in s.split(",") if o.strip()]

# Orígenes por defecto (añade aquí los que uses en dev)
_default_origins = [
    "https://app.pixelfluxcreative.com",
    "https://audit.pixelfluxcreative.com",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
]

_env_origins = _split_origins(os.getenv("CORS_ORIGINS"))
# Unificar y mantener orden (dict.fromkeys para deduplicar preservando orden)
origins = list(dict.fromkeys((_env_origins or []) + _default_origins))

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    # Regex por si en el futuro agregas más subdominios controlados (opcional dejarlo así):
    allow_origin_regex=r"https:\/\/(?:app|audit)\.pixelfluxcreative\.com$",
    allow_credentials=True,          # necesario para cookies (auth por cookie httpOnly)
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=86400,                   # cache del preflight (24h)
)


JWT_SECRET = os.getenv("JWT_SECRET")
ALGO = "HS256"

# En el demo público no se hacen llamadas salientes reales a Meta/WhatsApp —
# las conversaciones que se ven ya están sembradas, y "enviar" un mensaje
# solo lo agrega localmente a la DB (ver /waba/send y /waba/templates).
DEMO_READONLY = os.getenv("DEMO_READONLY", "true").lower() == "true"


#### META / WABA

VERIFY = os.getenv("META_VERIFY_TOKEN", "")

@app.get("/webhooks/meta")
def meta_verify(request: Request):
    mode = request.query_params.get("hub.mode")
    token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge")
    if mode == "subscribe" and token == VERIFY and challenge:
        return PlainTextResponse(challenge)
    raise HTTPException(status_code=403, detail="Verification failed")

@app.post("/webhooks/meta")
async def meta_webhook(request: Request, db: Session = Depends(lambda: next(get_db()))):
    if DEMO_READONLY:
        # Modo demo: nadie (ni Meta) debería estar llamando a este webhook,
        # pero al no tener verificación de firma, queda abierto a que un
        # visitante inyecte mensajes falsos en el inbox simulado. Sin efecto
        # en la demo pública: se rechaza igual que el resto de escrituras.
        raise HTTPException(status_code=403, detail="Modo demo: webhook deshabilitado.")
    data = await request.json()
    print("WEBHOOK META:", data)

    for entry in data.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value") or {}

            # 1) MENSAJES ENTRANTES
            if "messages" in value:
                contacts_map = {c.get("wa_id"): c for c in value.get("contacts", [])}

                for m in value.get("messages", []):
                    wa_id = m.get("from")
                    wamid = m.get("id")
                    mtype = m.get("type")
                    ts = datetime.fromtimestamp(int(m.get("timestamp", "0")), tz=timezone.utc).replace(tzinfo=None)

                    text = None
                    template_name = None
                    if mtype == "text":
                        text = (m.get("text") or {}).get("body")
                    elif mtype == "button":
                        text = (m.get("button") or {}).get("text")
                    elif mtype == "interactive":
                        text = str(m.get("interactive"))
                    elif mtype == "image":
                        pass
                    elif mtype == "reaction":
                        text = (m.get("reaction") or {}).get("emoji")

                    # upsert contacto
                    contact = db.query(Contact).filter(Contact.wa_id == wa_id).first()
                    if not contact:
                        profile_name = (contacts_map.get(wa_id, {}).get("profile") or {}).get("name")
                        contact = Contact(wa_id=wa_id, profile_name=profile_name, phone=wa_id, last_message_at=ts)
                        db.add(contact)
                        db.flush()
                    else:
                        contact.last_message_at = max(contact.last_message_at or ts, ts)

                    # inserta mensaje si no existe
                    exists = db.query(Message).filter(Message.wamid == wamid).first()
                    if not exists:
                        msg = Message(
                            contact_id=contact.id,
                            wa_id=wa_id,
                            wamid=wamid,
                            direction="in",
                            mtype=mtype,
                            text=text,
                            template_name=template_name,
                            ts=ts,
                            status=None,
                        )
                        db.add(msg)

                db.commit()

            # 2) ESTADOS de mensajes existentes
            if "statuses" in value:
                for s in value.get("statuses", []):
                    wamid = s.get("id")
                    status = s.get("status")
                    msg = db.query(Message).filter(Message.wamid == wamid).first()
                    if msg:
                        msg.status = status
                        db.add(msg)
                db.commit()

    return {"ok": True}

@app.post("/waba/send")
def waba_send(payload: dict = Body(...), db: Session = Depends(lambda: next(get_db()))):
    to = payload.get("to")
    if not to:
        raise HTTPException(status_code=400, detail="'to' es obligatorio (wa_id del destinatario)")

    mtype = payload.get("type")
    out_text = None
    template_name = None

    if mtype == "text":
        body = payload.get("text")
        if not body:
            raise HTTPException(status_code=400, detail="'text' requerido para mensajes de tipo text")
        out_text = body

    elif mtype == "template":
        template_name = payload.get("template_name")
        language = payload.get("language", "es")
        if not template_name:
            raise HTTPException(status_code=400, detail="'template_name' requerido para tipo template")

    else:
        raise HTTPException(status_code=400, detail="type soportado: 'text' o 'template'")

    if DEMO_READONLY:
        # Modo demo: no se llama a Meta. El mensaje se agrega localmente al
        # hilo simulado, igual que lo haría un envío real, para que la UI de
        # campañas se sienta interactiva sin tocar una API externa.
        res = {"demo": True, "note": "Envío simulado — no se llamó a la API de Meta."}
        wamid = f"demo-{int(datetime.utcnow().timestamp()*1000)}"
    else:
        TOKEN = os.getenv("META_SYSTEM_USER_TOKEN")
        PHONE_ID = os.getenv("META_PHONE_NUMBER_ID")
        if not TOKEN or not PHONE_ID:
            raise HTTPException(status_code=500, detail="WABA no configurado en el servidor")

        url = f"https://graph.facebook.com/v23.0/{PHONE_ID}/messages"
        headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
        data = {"messaging_product": "whatsapp", "to": to}
        if mtype == "text":
            data["type"] = "text"
            data["text"] = {"preview_url": False, "body": out_text}
        else:
            data["type"] = "template"
            tpl = {"name": template_name, "language": {"code": payload.get("language", "es")}}
            if payload.get("components"):
                tpl["components"] = payload["components"]
            data["template"] = tpl

        try:
            r = requests.post(url, headers=headers, json=data, timeout=30)
        except requests.RequestException as e:
            raise HTTPException(status_code=502, detail=f"Error conectando a Meta: {e}")

        if r.status_code >= 300:
            try:
                err = r.json()
            except Exception:
                err = {"raw": r.text}
            raise HTTPException(status_code=r.status_code, detail=err)

        res = r.json()
        wamid = None
        if isinstance(res.get("messages"), list) and res["messages"]:
            wamid = res["messages"][0].get("id")

    # Upsert contacto & guardar mensaje saliente
    contact = db.query(Contact).filter(Contact.wa_id == to).first()
    now = datetime.utcnow()
    if not contact:
        contact = Contact(wa_id=to, phone=to, last_message_at=now)
        db.add(contact)
        db.flush()
    else:
        contact.last_message_at = now

    msg = Message(
        contact_id=contact.id,
        wa_id=to,
        wamid=wamid or f"local-{int(now.timestamp())}",
        direction="out",
        mtype=mtype,
        text=out_text,
        template_name=template_name,
        ts=now,
        status="sent",
    )
    db.add(msg)
    db.commit()

    return {"ok": True, "wamid": wamid, "meta": res}


# =========================
# DB helpers locales
# =========================
def get_db():
    """
    Dependencia local que usa SessionLocal.
    Nota: Sombrea el get_db importado para mantener compatibilidad con el resto del archivo.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# =========================
# Misc endpoints
# =========================
@app.get("/healthz")
def healthz():
    return {"ok": True}

@app.get("/health", include_in_schema=False)
def health():
    # Respuesta mínima para que el healthcheck de Docker marque HEALTHY
    return {"status": "ok"}

@app.post("/auth/login")
def login(payload: dict, response: Response, db: Session = Depends(get_db)):
    email = payload.get("email", "").strip().lower()
    print("LOGIN attempt:", {"email": email})
    password = payload.get("password", "")
    user = db.query(User).filter(User.email == email).first()
    if not user or not verify_password(user.password_hash, password):
        raise HTTPException(status_code=401, detail="Credenciales inválidas")
    token = make_token(user.email)
    # cookie httpOnly; Lax sirve entre subdominios del mismo sitio
    response.set_cookie(key="access_token", value=token, httponly=True, secure=True, samesite="lax")
    return {"ok": True}

@app.post("/auth/logout")
def logout(response: Response):
    response.delete_cookie("access_token")
    return {"ok": True}

@app.post("/auth/demo-login")
def demo_login(response: Response, db: Session = Depends(get_db)):
    """
    One-click login for public demo visitors — issues a real JWT for the
    single seeded demo admin user, no password involved. Only works when
    DEMO_READONLY is set (never enabled against a real deployment).
    """
    if not DEMO_READONLY:
        raise HTTPException(status_code=404, detail="Not found")
    email = os.getenv("ADMIN_EMAIL")
    if not email:
        raise HTTPException(status_code=500, detail="Demo admin not configured")
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=500, detail="Demo admin not seeded yet")
    token = make_token(user.email)
    response.set_cookie(key="access_token", value=token, httponly=True, secure=True, samesite="lax")
    return {"ok": True}

@app.get("/me")
def me(request: Request, db: Session = Depends(get_db)):
    token = request.cookies.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="No autenticado")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[ALGO])
        email = payload.get("sub")
        if not email:
            raise HTTPException(status_code=401, detail="Token inválido")
    except JWTError:
        raise HTTPException(status_code=401, detail="Token inválido")
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    return {"email": user.email, "name": user.name or "Admin"}


# =========================
# WABA utilidades
# =========================
@app.get("/waba/contacts")
def list_contacts(limit: int = 50, offset: int = 0, db: Session = Depends(get_db)):
    q = (
        db.query(Contact)
        .order_by(Contact.last_message_at.is_(None), Contact.last_message_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    items = [
        {
            "id": c.id,
            "wa_id": c.wa_id,
            "name": c.profile_name or c.phone,
            "last_message_at": c.last_message_at.isoformat() if c.last_message_at else None,
        }
        for c in q
    ]
    return {"items": items}

@app.get("/waba/messages")
def list_messages(
    wa_id: str,
    limit: int = 50,
    since: str | None = None,
    db: Session = Depends(get_db),
):
    contact = db.query(Contact).filter(Contact.wa_id == wa_id).first()
    if not contact:
        return {"items": []}

    q = db.query(Message).filter(Message.contact_id == contact.id)

    if since:
        try:
            dt = datetime.fromisoformat(since)
            q = q.filter(Message.ts > dt)
        except Exception:
            pass

    q = q.order_by(Message.ts.desc()).limit(limit)

    items = [{
        "wamid": m.wamid,
        "direction": m.direction,
        "type": m.mtype,
        "text": m.text,
        "template_name": m.template_name,
        "status": m.status,
        "ts": m.ts.isoformat(),
    } for m in q.all()]

    items.reverse()
    return {"items": items}

_DEMO_TEMPLATES = [
    {"name": "first_contact", "language": "en", "category": "MARKETING", "body_params": 2},
    {"name": "audit_follow_up", "language": "en", "category": "MARKETING", "body_params": 1},
    {"name": "proposal_reminder", "language": "en", "category": "UTILITY", "body_params": 1},
]

@app.get("/waba/templates")
def list_templates(db: Session = Depends(get_db)):
    if DEMO_READONLY:
        # Modo demo: no se consulta la API de Meta. Plantillas de ejemplo,
        # con la misma forma que devolvería Graph API, para que la UI de
        # campañas funcione igual que en producción.
        return {"items": _DEMO_TEMPLATES}

    TOKEN = os.getenv("META_SYSTEM_USER_TOKEN")
    WABA_ID = os.getenv("META_WABA_ID")
    if not TOKEN or not WABA_ID:
        raise HTTPException(status_code=500, detail="Faltan credenciales WABA en el servidor")

    url = f"https://graph.facebook.com/v23.0/{WABA_ID}/message_templates"
    params = {"fields": "name,status,category,language,components", "limit": 200}
    try:
        r = requests.get(url, headers={"Authorization": f"Bearer {TOKEN}"}, params=params, timeout=30)
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Error consultando Meta: {e}")

    if r.status_code >= 300:
        raise HTTPException(status_code=r.status_code, detail=r.json() if r.headers.get("content-type","").startswith("application/json") else r.text)

    data = r.json().get("data", [])
    items = []
    for t in data:
        if t.get("status") != "APPROVED":
            continue
        body = next((c for c in (t.get("components") or []) if (c.get("type") or "").upper() == "BODY"), None)
        text = (body or {}).get("text") or ""
        params_count = len(re.findall(r"\{\{\d+\}\}", text))
        items.append({
            "name": t.get("name"),
            "language": t.get("language"),
            "category": t.get("category"),
            "body_params": params_count
        })
    return {"items": items}

@app.get("/waba/statuses")
def list_statuses(
    wa_id: str,
    limit: int = 120,
    out_only: bool = True,
    db: Session = Depends(get_db)
):
    contact = db.query(Contact).filter(Contact.wa_id == wa_id).first()
    if not contact:
        return {"items": []}

    q = db.query(Message.wamid, Message.status).filter(
        Message.contact_id == contact.id,
        Message.status.isnot(None)
    )
    if out_only:
        q = q.filter(Message.direction == "out")

    q = q.order_by(Message.ts.desc()).limit(limit)

    items = [{"wamid": w, "status": s} for (w, s) in q.all() if w]
    return {"items": items}
