# app/ai.py
import os, json, re
from typing import Dict, Any, Tuple
from openai import OpenAI

_client = None

def _client_singleton() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client

def _get_model() -> str:
    return os.getenv("OPENAI_MODEL", "gpt-4o-mini")  # configurable por env

def _estimate_cost_usd(prompt_tokens: int, completion_tokens: int) -> float:
    try:
        in_price = float(os.getenv("OPENAI_INPUT_COST_PER_1K", "0"))
        out_price = float(os.getenv("OPENAI_OUTPUT_COST_PER_1K", "0"))
        return (prompt_tokens/1000.0)*in_price + (completion_tokens/1000.0)*out_price
    except Exception:
        return 0.0

def _build_messages(lead: Dict[str, Any], analysis: Dict[str, Any], campaign_id: str | None = None):
    """
    Regla clave: NO mencionar ciudad/región (pero mantener el nombre del negocio tal cual llegue).
    """
    nombre = lead.get("name") or "Este negocio"
    website = lead.get("website") or ""
    rating = lead.get("rating")
    reviews = lead.get("reviews_count", 0)
    owner_resp = lead.get("owner_responses_count", 0)

    # Señales
    https_enabled = analysis.get("https_enabled")
    has_mailto = analysis.get("has_mailto")
    has_wa = analysis.get("has_whatsapp")
    has_social = analysis.get("has_social")
    http_status = analysis.get("http_status")
    score = analysis.get("score", 0)
    issues = analysis.get("issues", [])

    # Mensajes Chat Completions
    system_msg = {
        "role": "system",
        "content": (
            "You are a web sales advisor. Generate short, clear, persuasive copy in English.\n"
            "Never mention the business's city, region, or geographic location in the final text.\n"
            "Keep the business name exactly as given, but do not add a location.\n"
            "ALWAYS return a JSON object with two keys: 'pitch' (string, 2-4 sentences) and "
            "'checklist' (array of short bullets).\n"
            "Tone: professional and approachable, conversion-oriented."
        )
    }

    # Contexto del lead (sin ciudad/región en el copy)
    user_msg = {
        "role": "user",
        "content": json.dumps({
            "negocio": nombre,
            "website": bool(website),
            "website_url": website,
            "http_status": http_status,
            "https_enabled": bool(https_enabled),
            "contacto": {
                "mailto": bool(has_mailto),
                "whatsapp": bool(has_wa),
                "social": bool(has_social),
            },
            "reputacion": {
                "rating": rating,
                "reviews": reviews,
                "owner_responses": owner_resp,
            },
            "oportunidad_score": score,
            "issues": issues,
            "campania": campaign_id or None,
        }, ensure_ascii=False)
    }

    return [system_msg, user_msg]

def generate_lead_copy(lead: Dict[str, Any], analysis: Dict[str, Any], campaign_id: str | None = None) -> Tuple[Dict[str, Any], Dict[str, int]]:
    """
    Genera (vía OpenAI) un JSON con:
      - pitch: 3–6 frases EN TU VOZ (para ayudarte a decidir qué ofrecer), NO texto para el cliente final.
      - checklist: 6–12 bullets con cosas concretas que puedes vender/ofrecer o chequear.

    Usa si están disponibles (no son obligatorios):
      analysis.website_type, analysis.website_provider, analysis.website_root_domain,
      analysis.intention_score, analysis.score (oportunidad), analysis.issues (lista)

    Reglas clave:
      - Si website_type != OWN_SITE => foco en "sitio nuevo en dominio propio" (no reparar lo existente).
      - PLATFORM_SUBDOMAIN => nuevo proyecto en dominio propio (no “arreglos”).
      - MENU_QR/LINK_HUB => proponer web propia + landing link-in-bio en su dominio + tracking.
      - SOCIAL-únicamente => web propia + WhatsApp/CTA + SEO local.
      - Si ya tiene OWN_SITE => baja prioridad; sugerir “contenido” (reels/banners) y upsells ligeros.
      - NO mencionar ciudad/región (el llamado externo hará un sanitizado extra).
    """
    model = _get_model()
    client = _client_singleton()

    # Normaliza entradas y soporta claves opcionales
    lead_name = str(lead.get("name") or "").strip()
    website = str(lead.get("website") or "").strip()
    phone = str(lead.get("phone") or "").strip()
    rating = lead.get("rating")
    reviews_count = int(lead.get("reviews_count") or 0)
    owner_responses_count = int(lead.get("owner_responses_count") or 0)

    website_type = analysis.get("website_type") or "NONE"
    website_provider = analysis.get("website_provider") or None
    website_root_domain = analysis.get("website_root_domain") or None

    opportunity_score = int(analysis.get("score") or analysis.get("opportunity_score") or 0)
    intention_score = int(analysis.get("intention_score") or 0)

    https_enabled = bool(analysis.get("https_enabled") or False)
    has_mailto = bool(analysis.get("has_mailto") or False)
    has_whatsapp = bool(analysis.get("has_whatsapp") or False)
    has_social = bool(analysis.get("has_social") or False)
    http_status = analysis.get("http_status")
    issues = analysis.get("issues") or []
    if isinstance(issues, str):
        # por si viene serializado como string
        try:
            issues = json.loads(issues) or []
        except Exception:
            issues = [issues]

    # Mensajes Chat Completions — JSON puro
    system_msg = {
        "role": "system",
        "content": (
            "You are a sales consultant at an agency that SELLS new websites and content packages.\n"
            "Your output is for the salesperson's INTERNAL USE (not for the end customer).\n"
            "Return ONLY a JSON object with two keys: 'pitch' (string) and 'checklist' (array of strings).\n"
            "The 'pitch' must be direct and actionable, 3-6 sentences; the 'checklist' should have 6-12 bullets.\n"
            "Do not include city/region or any location data. Do not promise to fix an existing website.\n"
            "If the lead does NOT have their own site on their own domain (website_type != 'OWN_SITE'), prioritize proposing a NEW project on their own domain.\n"
            "If it's PLATFORM_SUBDOMAIN, avoid 'fixing' it — propose migrating to their own domain with a new site.\n"
            "If it's MENU_QR or LINK_HUB, acknowledge the intent and offer: own website + link-in-bio landing page on their domain + tracking.\n"
            "If there's only SOCIAL presence, offer a proper website with WhatsApp/CTA and local SEO to capture intent-driven searches.\n"
            "If they already have OWN_SITE, lower the priority and suggest content packages (reels/banners) and light improvements ONLY if asked.\n"
            "Always think in packages: Base/Restaurant/Services website + add-ons (Reels/Banners/Promos)."
        ),
    }

    user_ctx = {
        "lead": {
            "name": lead_name,
            "website": website,
            "phone": phone,
            "rating": rating,
            "reviews_count": reviews_count,
            "owner_responses_count": owner_responses_count,
        },
        "analysis": {
            "website_type": website_type,
            "website_provider": website_provider,
            "website_root_domain": website_root_domain,
            "opportunity_score": opportunity_score,
            "intention_score": intention_score,
            "https_enabled": https_enabled,
            "has_mailto": has_mailto,
            "has_whatsapp": has_whatsapp,
            "has_social": has_social,
            "http_status": http_status,
            "issues": issues,
        },
        "campaign_id": campaign_id,
        "output_contract": {
            "type": "object",
            "required": ["pitch", "checklist"],
            "properties": {
                "pitch": {"type": "string"},
                "checklist": {"type": "array", "items": {"type": "string"}},
            },
        },
    }

    user_msg = {
        "role": "user",
        "content": (
            "Generate a JSON object for the SALESPERSON with recommendations on what to offer.\n"
            "Desired structure (example):\n"
            "{\n"
            '  "pitch": "Express diagnosis + Recommended offer + Suggested package + Situational upsells + Next step",\n'
            '  "checklist": ["Has/doesn\'t have X", "Propose: new site on own domain + SSL", "Integrate WhatsApp + CTA", "Basic local SEO (schema)", "Indexable menu (if applicable)", "Analytics + events", "Link-in-bio landing page on THEIR own domain", "Reels pack (4/8/12)", "Promo banners (2/4 per month)"]\n'
            "}\n"
            "Return ONLY valid JSON."
        ),
    }

    resp = client.chat.completions.create(
        model=model,
        messages=[system_msg, {"role": "user", "content": json.dumps(user_ctx, ensure_ascii=False)}, user_msg],
        response_format={"type": "json_object"},
        temperature=0.4,
        max_tokens=400,
    )

    content = resp.choices[0].message.content or "{}"
    try:
        data = json.loads(content)
    except Exception:
        # Fallback: intenta extraer bloque JSON
        m = re.search(r"\{.*\}", content, flags=re.S)
        data = json.loads(m.group(0)) if m else {"pitch": "", "checklist": []}

    usage = {"prompt_tokens": 0, "completion_tokens": 0}
    u = getattr(resp, "usage", None)
    if u:
        # Compat v1
        pt = getattr(u, "prompt_tokens", None)
        ct = getattr(u, "completion_tokens", None)
        if pt is not None and ct is not None:
            usage["prompt_tokens"] = int(pt or 0)
            usage["completion_tokens"] = int(ct or 0)
        else:
            # Por si el SDK cambia nombres
            usage = {k: int(getattr(u, k) or 0) for k in ("prompt_tokens", "completion_tokens") if hasattr(u, k)}

    # Sanitizado extra por si el modelo metió geos (el endpoint ya hace un pass adicional)
    data["pitch"] = data.get("pitch", "").strip()
    if isinstance(data.get("checklist"), list):
        data["checklist"] = [str(x).strip() for x in data["checklist"] if str(x).strip()]

    return data, usage


def decorate_pitch_no_geo(text: str, banned: list[str]) -> str:
    """
    Segunda barrera: elimina menciones explícitas de ubicaciones si se colaron.
    Mantiene el nombre del negocio tal cual lo recibimos en 'lead.name'.
    """
    if not text:
        return text
    out = text
    for token in banned:
        if not token:
            continue
        # elimina solo cuando aparece como palabra suelta (case-insensitive)
        out = re.sub(rf"(\b){re.escape(token)}(\b)", "", out, flags=re.IGNORECASE)
    # Limpieza de espacios dobles
    out = re.sub(r"\s{2,}", " ", out).strip()
    return out
