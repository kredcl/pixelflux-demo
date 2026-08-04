# PixelFlux — Lead Intelligence Platform (public demo)

This repo is a **sanitized version of a real production system**, adapted as a portfolio piece for job applications.

Live demo: `https://demo.pixelfluxcreative.com`

## What this is

PixelFlux is a platform that finds businesses with weak digital presence, scores them automatically with AI, generates personalized audits of their site/social presence, and manages first contact with human oversight. It's been in production since 2025, with over 10,000 qualified leads and an active partnership in Canada.

This repo shows the real architecture and code — **but everything you see here (businesses, contacts, conversations) is 100% fictional**, generated for the demo. None of it belongs to a real client.

## What's real vs. simulated in this demo

| Component | Status |
|---|---|
| Opportunity scoring, website classification, audit generation | **Real** — same code as production, run against synthetic data at seed time |
| Dashboard and aggregations | **Real** — working against the synthetic data |
| Tokenized audit links | **Real** — genuinely generated and served |
| Scraper (Google Maps) | **Disabled** — the interface is there, but it doesn't run real searches |
| WhatsApp sending (Meta Graph API) | **Mocked** — pre-seeded conversations, no real outbound calls |

No interaction from a public demo visitor ever triggers a real call to an external provider (OpenAI, Meta, or a fetch to a third-party site).

## Stack

- **API:** FastAPI (Python) + SQLAlchemy + MariaDB
- **Web:** Next.js (TypeScript) + Tailwind

## Run locally

```bash
cp .env.example .env
# fill in .env with your own values
docker compose up --build
```

## Contact

Built by Derek Folch as a portfolio piece. [derek.folch@gmail.com](mailto:derek.folch@gmail.com)
