# PixelFlux — Lead Intelligence Platform (demo público)

Este repo es una **versión sanitizada de un sistema real en producción**, adaptada como pieza de portafolio para postulaciones de trabajo.

Demo en vivo: `https://demo.pixelfluxcreative.com` *(en construcción)*

## Qué es esto

PixelFlux es una plataforma que encuentra negocios con presencia digital débil, los puntúa automáticamente con IA, genera auditorías personalizadas de su sitio/redes, y gestiona el contacto inicial con supervisión humana. Corre en producción desde 2025, con más de 10.000 leads calificados y un partnership activo en Canadá.

Este repo muestra la arquitectura y el código real del sistema — **pero todos los datos que ves acá (negocios, contactos, conversaciones) son 100% ficticios**, generados para la demo. Nada de esto pertenece a un cliente real.

## Qué es real y qué está simulado en esta demo

| Componente | Estado |
|---|---|
| Scoring de oportunidad, clasificación de sitio, generación de auditorías | **Real** — mismo código que producción, corrido sobre datos sintéticos al sembrar |
| Dashboard y agregaciones | **Real** — funcionando contra la data sintética |
| Links de auditoría tokenizados | **Real** — generados y servidos de verdad |
| Scraper (Google Maps) | **Deshabilitado** — la interfaz se ve pero no ejecuta búsquedas reales |
| Envío de WhatsApp (Meta Graph API) | **Mockeado** — conversaciones pre-sembradas, sin llamadas salientes reales |

Ninguna interacción de un visitante público de la demo dispara una llamada real a un proveedor externo (Anthropic, Meta, o cualquier fetch a un sitio de terceros).

## Stack

- **API:** FastAPI (Python) + SQLAlchemy + MariaDB
- **Web:** Next.js (TypeScript) + Tailwind

## Correr localmente

```bash
cp .env.example .env
# completar .env con valores propios
docker compose up --build
```

## Contacto

Construido por Derek Folch como pieza de portafolio. [derek.folch@gmail.com](mailto:derek.folch@gmail.com)
