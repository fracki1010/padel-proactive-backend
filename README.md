# padel-proactive-backend

## Frontend y backend separados

- Frontend (Firebase): usar `../padel-proactive-frontend/.env.example` y definir `VITE_API_URL` apuntando al backend.
- Backend: usar `.env.production.example` y definir `CORS_ORIGIN` con el dominio del frontend.

## Ejecucion desacoplada (recomendada)

- API HTTP: `npm start` (dev: `npm run dev`)
- Worker WhatsApp: `npm run start:worker` (dev: `npm run dev:worker`)

Modo legacy (todo en un proceso):

- `npm run start:combined`

## Docker Compose (API + Worker separados)

Servicios:

- `padel-proactive-api` (`apiServer.js`)
- `padel-proactive-wa-worker` (`waWorker.js`)

Desplegar solo API (sin reiniciar WhatsApp worker):

```bash
docker compose up -d --build --no-deps padel-proactive-api
```

Desplegar solo worker (cuando hay cambios de bot):

```bash
docker compose up -d --build --no-deps padel-proactive-wa-worker
```

Desplegar ambos:

```bash
docker compose up -d --build
```

## Observabilidad de worker

`GET /api/config/whatsapp` ahora incluye:

- `workerOnline`
- `workerHeartbeatAt`
- `workerId`
- `workerStaleAfterMs`

Variables asociadas:

- `WORKER_HEARTBEAT_INTERVAL_MS` (default `10000`)
- `WORKER_HEARTBEAT_STALE_MS` (default `30000`)
