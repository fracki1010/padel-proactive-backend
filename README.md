# padel-proactive-backend

Backend API desacoplado del worker de WhatsApp.

## Arquitectura recomendada

- Repo 1: `padel-proactive-backend` (API)
- Repo 2: `padel-proactive-whatsapp-worker` (sesiones WhatsApp)
- Comunicación principal: Redis + BullMQ

## Variables importantes

- `WHATSAPP_QUEUE_DRIVER=redis`
- `WHATSAPP_QUEUE_NAME=whatsapp-commands`
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`, `REDIS_PASSWORD`, `REDIS_TLS`

## Ejecución

API:

```bash
npm start
```

El worker ya no tiene que correr en este repo cuando usás arquitectura separada.

## Endpoints útiles

- `GET /api/config/whatsapp` (incluye estado runtime y heartbeat de worker)
- `GET /api/whatsapp/commands`
- `GET /api/whatsapp/commands/:id`
- `POST /api/whatsapp/commands/:id/retry`

## Deploy

Deploy solo API:

```bash
docker compose up -d --build --no-deps padel-proactive-api
```
