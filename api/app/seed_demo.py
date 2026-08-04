"""
Seeds the public demo with 100% fictional businesses.

Unlike a fixture dump, this runs the REAL classification/scoring code
(app.routers.leads) and the REAL audit-generation code (app.routers.audits)
against synthetic input — so every score, issue, and audit link on the demo
is a genuine output of the production logic, just computed once here at
seed time instead of during a live visit (see DEMO_READONLY in main.py).

Run once against an empty demo database, after seed_admin.py:
    python -m app.seed_admin
    python -m app.seed_demo
"""
import json
import random
from datetime import datetime, timedelta

from app.db import Base, engine, SessionLocal
from app.models import (
    ScraperRun,
    ScraperResult,
    ScraperReview,
    LeadAnalysis,
    Campaign,
    CampaignLead,
    CampaignStatus,
    Contact,
    Message,
    Audit,
    AuditKind,
)
from app.routers.leads import (
    _classify_website,
    _compute_intention_score,
    _compute_score_and_issues,
    _has_whatsapp_in_url,
)
import app.routers.audits as audits_router
import app.routers.campaigns as campaigns_router
from app.routers.audits import generate_basic_for_campaign, generate_premium_for_campaign
from app.routers.campaigns import generate_messages_for_campaign

# Este script llama a las funciones de escritura reales directamente (no vía
# HTTP), para seguir generando la data sembrada con el mismo código real de
# producción. DEMO_READONLY sigue protegiendo esos endpoints del resto del
# mundo (ver routers/audits.py y routers/campaigns.py) -- solo se desactiva
# acá, en el proceso aislado del seeding, nunca en el servidor que sirve la API.
audits_router.DEMO_READONLY = False
campaigns_router.DEMO_READONLY = False

random.seed(42)  # reproducible dataset across re-seeds

Base.metadata.create_all(bind=engine)


# ---------------------------------------------------------------------------
# Fictional data building blocks
# ---------------------------------------------------------------------------

NICHES = [
    "Restaurant", "Hair Salon", "Dental Clinic", "Auto Repair Shop",
    "Law Firm", "Plumbing Service", "Yoga Studio", "Pet Grooming",
    "Real Estate Agency", "Gym", "Bakery", "Auto Detailing",
]

CITIES = [
    ("Vancouver", "BC", "CA"), ("Victoria", "BC", "CA"), ("Kelowna", "BC", "CA"),
    ("Nanaimo", "BC", "CA"), ("Calgary", "AB", "CA"), ("Edmonton", "AB", "CA"),
]

NAME_PREFIXES = [
    "North", "Riverside", "Summit", "Harbor", "Cedar", "Maple", "Golden",
    "Pacific", "Silver", "Downtown", "Lakeside", "Evergreen", "Coastal",
    "Sunrise", "Foothill",
]
NAME_SUFFIXES = {
    "Restaurant": ["Kitchen", "Bistro", "Grill", "Table"],
    "Hair Salon": ["Hair Studio", "Salon", "Hair Co."],
    "Dental Clinic": ["Dental", "Family Dentistry", "Dental Care"],
    "Auto Repair Shop": ["Auto Repair", "Motors", "Garage"],
    "Law Firm": ["Law Group", "Legal", "& Associates"],
    "Plumbing Service": ["Plumbing", "Plumbing Co.", "Drain & Plumbing"],
    "Yoga Studio": ["Yoga Studio", "Yoga Collective", "Yoga Space"],
    "Pet Grooming": ["Pet Grooming", "Pet Spa", "Groomers"],
    "Real Estate Agency": ["Realty", "Real Estate Group", "Properties"],
    "Gym": ["Fitness", "Gym", "Strength Club"],
    "Bakery": ["Bakery", "Bake Shop", "Baking Co."],
    "Auto Detailing": ["Auto Detailing", "Detail Studio", "Car Care"],
}

REVIEW_SNIPPETS_GOOD = [
    "Great service, will definitely come back.",
    "Super friendly staff and fast turnaround.",
    "Best in town, highly recommend.",
    "They really know what they're doing. Five stars.",
    "Clean, professional, and reasonably priced.",
]
REVIEW_SNIPPETS_MIXED = [
    "Good but a bit pricey for what you get.",
    "Service was fine, had to wait a while though.",
    "Decent experience, nothing special.",
]
REVIEW_AUTHORS = ["J. Miller", "A. Chen", "R. Thompson", "S. Patel", "K. Brown", "M. Rodriguez", "L. Nguyen"]


def _biz_name(niche: str, rng: random.Random) -> str:
    prefix = rng.choice(NAME_PREFIXES)
    suffix = rng.choice(NAME_SUFFIXES[niche])
    return f"{prefix} {suffix}"


def _fake_phone(rng: random.Random) -> str:
    # Canadian-format, clearly synthetic (555 exchange is reserved/unused)
    return f"+1604555{rng.randint(1000, 9999)}"


def _fake_address(rng: random.Random) -> str:
    return f"{rng.randint(100, 9999)} {rng.choice(['Main St', 'Oak Ave', 'King St', '4th Ave', 'Broadway'])}"


# ---------------------------------------------------------------------------
# Website "personas" — each returns (website_url_or_None, flags_for_scoring)
# flags mirror exactly what reanalyze_lead would produce, without any live
# HTTP fetch: for non-OWN_SITE types the real code never fetches at all
# (see routers/leads.py reanalyze_lead's else-branch), and for OWN_SITE we
# hand-construct the same shape _fetch_and_analyze would return.
# ---------------------------------------------------------------------------

def _no_fetch_flags(website: str | None) -> dict:
    return {
        "http_status": None,
        "https_enabled": False,
        "has_mailto": False,
        "has_whatsapp": _has_whatsapp_in_url(website),
        "has_social": False,
        "waf_restricted": False,
        "last_http_variant": None,
        "last_http_method": None,
        "last_fetch_reason": None,
    }


def persona_none(slug, rng):
    return None, _no_fetch_flags(None)


def persona_social(slug, rng):
    url = f"https://instagram.com/{slug}"
    return url, _no_fetch_flags(url)


def persona_link_hub(slug, rng):
    url = f"https://linktr.ee/{slug}"
    return url, _no_fetch_flags(url)


def persona_menu_qr(slug, rng):
    url = f"https://fu.do/{slug}"
    return url, _no_fetch_flags(url)


def persona_marketplace(slug, rng):
    url = f"https://www.yelp.com/biz/{slug}"
    return url, _no_fetch_flags(url)


def persona_platform_subdomain(slug, rng):
    url = f"https://{slug}.wixsite.com/home"
    return url, _no_fetch_flags(url)


def persona_own_site_healthy(slug, rng):
    url = f"https://www.{slug}.com"
    flags = {
        "http_status": 200, "https_enabled": True, "has_mailto": True,
        "has_whatsapp": True, "has_social": True, "waf_restricted": False,
        "last_http_variant": "v1:h2:https://", "last_http_method": "GET",
        "last_fetch_reason": "ok",
    }
    return url, flags


def persona_own_site_down(slug, rng):
    url = f"https://www.{slug}.ca"
    flags = {
        "http_status": None, "https_enabled": True, "has_mailto": False,
        "has_whatsapp": False, "has_social": False, "waf_restricted": False,
        "last_http_variant": None, "last_http_method": "GET",
        "last_fetch_reason": "timeout(get)",
    }
    return url, flags


def persona_own_site_waf(slug, rng):
    url = f"https://www.{slug}.net"
    flags = {
        "http_status": 403, "https_enabled": True, "has_mailto": False,
        "has_whatsapp": False, "has_social": False, "waf_restricted": True,
        "last_http_variant": "v1:h2:https://", "last_http_method": "GET",
        "last_fetch_reason": "status(403)",
    }
    return url, flags


def persona_own_site_partial(slug, rng):
    url = f"https://{slug}.com"
    flags = {
        "http_status": 200, "https_enabled": False, "has_mailto": False,
        "has_whatsapp": True, "has_social": False, "waf_restricted": False,
        "last_http_variant": "v1:h2:http://", "last_http_method": "GET",
        "last_fetch_reason": "ok",
    }
    return url, flags


PERSONAS = [
    persona_none, persona_social, persona_link_hub, persona_menu_qr,
    persona_marketplace, persona_platform_subdomain,
    persona_own_site_healthy, persona_own_site_healthy,  # weight it a bit more
    persona_own_site_down, persona_own_site_waf, persona_own_site_partial,
]


# ---------------------------------------------------------------------------
# Hand-written AI pitch/checklist variants (no live OpenAI call — see
# conversation with Derek: demo seeding avoids external cost/dependency)
# ---------------------------------------------------------------------------

PITCH_VARIANTS = {
    "NONE": {
        "pitch": (
            "This lead has no website at all — right now they rely entirely on Google's "
            "profile and word of mouth. That's the strongest possible case for a brand-new "
            "site: every visit today is a missed conversion opportunity. Lead with the "
            "'new project on your own domain' framing, not a repair."
        ),
        "checklist": [
            "No website — propose a new site on their own domain",
            "Integrate WhatsApp + clear CTA",
            "Basic local SEO (schema, Google Business linkout)",
            "Add a contact/booking flow",
            "Suggest Base package + WhatsApp add-on",
        ],
    },
    "SOCIAL": {
        "pitch": (
            "They're active on social but have nothing on their own domain — good sign of "
            "intent, weak conversion path. Position a website as the natural next step from "
            "an audience they've already built, not a cold pitch."
        ),
        "checklist": [
            "Has Instagram — no owned website",
            "Propose: website + link-in-bio landing on their own domain",
            "Carry over their existing visual brand from social",
            "Add WhatsApp CTA + local SEO",
        ],
    },
    "LINK_HUB": {
        "pitch": (
            "A link-in-bio tool is a clear signal they know they need a hub, they just haven't "
            "invested in their own one yet. Reframe: same convenience, but on a domain they "
            "own and that Google actually indexes."
        ),
        "checklist": [
            "Currently using a link-in-bio tool, not a real website",
            "Propose: migrate to a real site on their own domain",
            "Keep the link-hub simplicity, add SEO + analytics",
            "Add booking/contact form",
        ],
    },
    "MENU_QR": {
        "pitch": (
            "They're already paying for a QR/menu ordering platform — that's budget and intent "
            "already proven. The pitch is upgrading to a real site that keeps ordering but adds "
            "discoverability, since the QR platform alone won't show up in Google searches."
        ),
        "checklist": [
            "Uses a QR/menu ordering platform (intent signal)",
            "Propose: real website with the ordering flow embedded",
            "Add SEO — QR platforms rarely get indexed",
            "Bundle with content package (menu photos, promos)",
        ],
    },
    "MARKETPLACE": {
        "pitch": (
            "They only show up through a marketplace listing, which means they're renting "
            "their visibility and competing on the platform's terms. A proper site gives them "
            "a channel that isn't shared with every competitor on the same listing page."
        ),
        "checklist": [
            "Only visible through a marketplace listing",
            "Propose: own website to reduce platform dependency",
            "Add direct WhatsApp/contact channel",
            "Local SEO to capture branded searches",
        ],
    },
    "PLATFORM_SUBDOMAIN": {
        "pitch": (
            "They built something on a page-builder subdomain — real effort, wrong foundation. "
            "This is a 'graduate to your own domain' pitch, not a 'you have no website' pitch; "
            "lead with what they already did right."
        ),
        "checklist": [
            "Has a site, but on a shared platform subdomain",
            "Propose: migrate to their own domain, same content",
            "Improve SEO (subdomains rank worse)",
            "Light content refresh while migrating",
        ],
    },
    "OWN_SITE_DOWN": {
        "pitch": (
            "Their own site exists but didn't respond when checked — that's actively costing "
            "them visits right now, not a someday problem. Lead with urgency: every visitor "
            "today is bouncing before they see anything."
        ),
        "checklist": [
            "Own site, but not loading reliably — urgent",
            "Propose: rebuild/fix on stable hosting",
            "Add uptime monitoring",
            "Quick win — high urgency, easy close",
        ],
    },
    "OWN_SITE_WAF": {
        "pitch": (
            "The site is up but returning restricted-access responses to outside checks — "
            "worth a light technical audit conversation rather than a hard sell, since this "
            "could be a security tool misconfigured to block legitimate traffic too."
        ),
        "checklist": [
            "Own site, but access is restricted (WAF/anti-bot)",
            "Offer a technical review — may be blocking real visitors too",
            "Confirm HTTPS + contact channels once accessible",
        ],
    },
    "OWN_SITE_PARTIAL": {
        "pitch": (
            "They have a working site missing a few basics — HTTPS or a direct contact "
            "channel. This is a light-touch upsell, not a full rebuild: quick wins, fast close."
        ),
        "checklist": [
            "Own site works, but missing HTTPS and/or WhatsApp/social links",
            "Propose: quick technical fixes package",
            "Add WhatsApp CTA + social links",
            "Low effort, fast turnaround pitch",
        ],
    },
    "OWN_SITE_HEALTHY": {
        "pitch": (
            "Their site already covers the basics well — HTTPS, contact channels, social. "
            "Low priority for a rebuild; the upsell here is content (reels/banners) and light "
            "conversion improvements, not a new site."
        ),
        "checklist": [
            "Own site already solid — low priority for a rebuild",
            "Upsell: content package (reels/banners)",
            "Light conversion improvements only if asked",
        ],
    },
}


def _pitch_key(website_type: str, persona_fn) -> str:
    if website_type != "OWN_SITE":
        return website_type
    name = persona_fn.__name__
    if "down" in name:
        return "OWN_SITE_DOWN"
    if "waf" in name:
        return "OWN_SITE_WAF"
    if "partial" in name:
        return "OWN_SITE_PARTIAL"
    return "OWN_SITE_HEALTHY"


# ---------------------------------------------------------------------------
# Seeding
# ---------------------------------------------------------------------------

def run():
    rng = random.Random(42)
    db = SessionLocal()
    try:
        if db.query(ScraperRun).count() > 0:
            print("[seed_demo] Data already present — skipping (idempotent).")
            return

        run_row = ScraperRun(
            status="done", total=0, ok=0, error=0,
            created_at=datetime.utcnow() - timedelta(days=3),
            started_at=datetime.utcnow() - timedelta(days=3),
            finished_at=datetime.utcnow() - timedelta(days=3, hours=-1),
        )
        db.add(run_row)
        db.commit()
        db.refresh(run_row)

        leads = []  # (ScraperResult, LeadAnalysis, website_type)

        counter = 0
        for niche in NICHES:
            for city, region, country in rng.sample(CITIES, k=3):
                persona_fn = PERSONAS[counter % len(PERSONAS)]
                counter += 1

                name = _biz_name(niche, rng)
                slug = name.lower().replace(" ", "").replace(".", "").replace("&", "and")
                place_id = f"demo-{slug}-{counter}"
                website, flags = persona_fn(slug, rng)

                reviews_count = rng.choice([0, 0, 3, 8, 15, 30, 60, 120])
                owner_resp = rng.randint(0, min(3, reviews_count)) if reviews_count else 0
                rating = round(rng.uniform(3.2, 5.0), 1) if reviews_count > 0 else None

                sr = ScraperResult(
                    run_id=run_row.id,
                    source="gmaps",
                    place_id=place_id,
                    name=name,
                    category=niche,
                    phone_raw=_fake_phone(rng),
                    phone_e164=_fake_phone(rng),
                    phone=_fake_phone(rng),
                    website=website,
                    address=_fake_address(rng),
                    city=city,
                    region=region,
                    country=country,
                    rating=rating,
                    review_count=reviews_count,
                    maps_url=f"https://maps.google.com/?q={place_id}",
                    query=f"{niche} in {city}",
                    query_group=niche,
                    in_zone=True,
                    reviews_count=reviews_count,
                    owner_responses_count=owner_resp,
                )
                db.add(sr)
                db.commit()
                db.refresh(sr)

                classification = _classify_website(website)
                website_type = classification["website_type"]
                website_exists = website_type == "OWN_SITE"

                score_issues = _compute_score_and_issues(
                    flags=flags,
                    reviews_count=reviews_count,
                    owner_responses_count=owner_resp,
                    website_exists=website_exists,
                )
                intention = _compute_intention_score(
                    website_type=website_type,
                    has_whatsapp_hint=bool(flags.get("has_whatsapp")),
                    reviews_count=reviews_count,
                    owner_responses_count=owner_resp,
                )
                priority = int(round(0.7 * score_issues["score"] + 0.3 * intention))

                pitch_data = PITCH_VARIANTS[_pitch_key(website_type, persona_fn)]

                la = LeadAnalysis(
                    place_id=place_id,
                    result_id=sr.id,
                    website_exists=website_exists,
                    http_status=flags.get("http_status"),
                    https_enabled=bool(flags.get("https_enabled")),
                    has_mailto=bool(flags.get("has_mailto")),
                    has_whatsapp=bool(flags.get("has_whatsapp")),
                    has_social=bool(flags.get("has_social")),
                    score=score_issues["score"],
                    issues_json=json.dumps(score_issues["issues"], ensure_ascii=False),
                    website_type=website_type,
                    website_provider=classification["website_provider"],
                    website_root_domain=classification["website_root_domain"],
                    intention_score=intention,
                    priority_score=priority,
                    ai_pitch=pitch_data["pitch"],
                    ai_checklist=json.dumps(pitch_data["checklist"], ensure_ascii=False),
                    model_name="gpt-4o-mini (pre-written for demo, see seed_demo.py)",
                    waf_restricted=bool(flags.get("waf_restricted")),
                    last_http_variant=flags.get("last_http_variant"),
                    last_http_method=flags.get("last_http_method"),
                    last_fetch_reason=flags.get("last_fetch_reason"),
                    lead_status="active",
                )
                db.add(la)
                db.commit()

                # A couple of sample reviews for the audit "reputation" block
                if reviews_count > 0:
                    n_samples = min(2, reviews_count)
                    for _ in range(n_samples):
                        good = rating is not None and rating >= 4.2
                        text = rng.choice(REVIEW_SNIPPETS_GOOD if good else REVIEW_SNIPPETS_MIXED)
                        db.add(ScraperReview(
                            run_id=run_row.id,
                            result_id=sr.id,
                            place_id=place_id,
                            review_id=f"{place_id}-r{_}",
                            author=rng.choice(REVIEW_AUTHORS),
                            rating=rng.randint(4, 5) if good else rng.randint(3, 4),
                            text=text,
                            published_at=datetime.utcnow() - timedelta(days=rng.randint(1, 90)),
                            lang="en",
                        ))
                    db.commit()

                leads.append((sr, la, website_type))

        print(f"[seed_demo] Seeded {len(leads)} synthetic leads across {len(NICHES)} niches / {len(CITIES)} cities.")

        # -------------------------------------------------------------
        # Campaign: assign every lead with a phone + a meaningful score
        # -------------------------------------------------------------
        camp = Campaign(
            name="Fall Outreach — BC & Alberta",
            status=CampaignStatus.ACTIVA,
            description="Demo campaign: outreach to businesses with weak digital presence found across the seeded synthetic dataset.",
            cta_basic_variant="whatsapp_premium",
        )
        db.add(camp)
        db.commit()
        db.refresh(camp)

        targeted = [l for l in leads if l[1].score >= 40]
        for sr, la, _wt in targeted:
            db.add(CampaignLead(campaign_id=camp.id, place_id=sr.place_id))
        db.commit()
        print(f"[seed_demo] Assigned {len(targeted)} leads to campaign #{camp.id}.")

        # Real audit generation (same code path as production)
        basic_res = generate_basic_for_campaign(campaign_id=camp.id, days_valid=30, db=db)
        print(f"[seed_demo] Basic audits: {basic_res}")

        premium_targets = [sr.place_id for sr, la, _wt in targeted if la.score >= 70][:8]
        if premium_targets:
            premium_res = generate_premium_for_campaign(
                campaign_id=camp.id, place_ids=premium_targets, days_valid=30, db=db,
            )
            print(f"[seed_demo] Premium audits: {premium_res}")

        # Real message generation (template + heuristic, same code path)
        msg_res = generate_messages_for_campaign(campaign_id=camp.id, mode="all", overwrite=True, payload=None, db=db)
        print(f"[seed_demo] Messages generated: {msg_res}")

        # -------------------------------------------------------------
        # WhatsApp conversation threads (simulated, no real WABA calls)
        # -------------------------------------------------------------
        convo_leads = targeted[:3]
        now = datetime.utcnow()
        for i, (sr, la, _wt) in enumerate(convo_leads):
            wa_id = sr.phone_e164.replace("+", "")
            contact = Contact(
                wa_id=wa_id,
                profile_name=sr.name,
                phone=sr.phone_e164,
                last_message_at=now - timedelta(hours=2 - i),
            )
            db.add(contact)
            db.commit()
            db.refresh(contact)

            cl = db.query(CampaignLead).filter(CampaignLead.place_id == sr.place_id).first()
            outreach_text = (cl.message if cl and cl.message else f"Hi {sr.name}, we put together a free digital audit for you.")

            thread = [
                ("out", outreach_text, "read", -180),
            ]
            if i != 1:
                thread.append(("in", "Hi! Thanks for reaching out, can you tell me more?", None, -170))
                thread.append(("out", "Of course! The audit link shows exactly what we found — happy to walk you through it on a quick call if useful.", "delivered" if i == 0 else "read", -165))
            if i == 0:
                thread.append(("in", "This is great, let's set up a call this week.", None, -60))

            for direction, text, status, minutes_offset in thread:
                db.add(Message(
                    contact_id=contact.id,
                    wa_id=wa_id,
                    wamid=f"demo-{contact.id}-{minutes_offset}",
                    direction=direction,
                    mtype="text",
                    text=text,
                    ts=now + timedelta(minutes=minutes_offset),
                    status=status,
                ))
            db.commit()

        print(f"[seed_demo] Seeded {len(convo_leads)} simulated WhatsApp conversations.")
        print("[seed_demo] Done.")
    finally:
        db.close()


if __name__ == "__main__":
    run()
