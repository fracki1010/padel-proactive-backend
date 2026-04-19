# padel-proactive-backend

Backend API desacoplado del worker de WhatsApp.

## Arquitectura recomendada

- Repo 1: `padel-proactive-backend` (API)
- Repo 2: `padel-proactive-whatsapp-worker` (sesiones WhatsApp)
- Comunicación principal: Redis + BullMQ
- El backend funciona como productor de comandos; no ejecuta sesión WhatsApp local en producción.

## Variables importantes

- `WHATSAPP_QUEUE_DRIVER=redis`
- `WHATSAPP_QUEUE_NAME=whatsapp-commands`
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`, `REDIS_PASSWORD`, `REDIS_TLS`
- `WHATSAPP_ALLOW_MONGO_FALLBACK=false` (opcional; solo dev)

## Ejecución

API:

```bash
npm start
```

El worker ya no tiene que correr en este repo cuando usás arquitectura separada.

Tests unitarios:

```bash
npm test
```

Auditoría defensiva WhatsApp (180 casos + reporte):

```bash
npm run test:wa:audit
```

Flags útiles del replay:
- `--section <N>`: ejecuta solo una sección
- `--same-session`: fuerza misma sesión para todos los casos
- `--report-file <path>`: guarda reporte markdown
- `--strict-assertions`: retorna error si hay violaciones

## Endpoints útiles

- `GET /api/config/whatsapp` (incluye estado runtime y heartbeat de worker)
- `GET /api/config/whatsapp/groups` (snapshot de grupos + `commandId` para refresco)
- `GET /api/config/whatsapp/chats?type=group` (alias de compatibilidad; devuelve los mismos grupos en `groups` y `chats`)
- `GET /api/whatsapp/commands`
- `GET /api/whatsapp/commands/:id`
- `POST /api/whatsapp/commands/:id/retry`
- `GET /api/whatsapp/groups` (alias de compatibilidad de listado de grupos)
- `GET /api/whatsapp/chats?type=group` (alias de compatibilidad de listado de grupos)
- `POST /api/bookings/fixed-turns/rematerialize` (admin/super_admin, rematerializa turnos fijos a bookings futuros)

### Rematerialización manual de turnos fijos

Endpoint:

```http
POST /api/bookings/fixed-turns/rematerialize
Authorization: Bearer <token-admin>
Content-Type: application/json
```

Body opcional:

```json
{
  "companyId": "6636f5d7b1f77f4b3f0f1111",
  "fromDate": "2026-04-16",
  "daysAhead": 90,
  "userId": "6636f5d7b1f77f4b3f0f2222"
}
```

Notas:
- `fromDate` default: hoy (UTC 00:00).
- `daysAhead` default: 90, máximo 365.
- `userId` filtra por un cliente puntual (opcional).
- `companyId` solo aplica para `super_admin`; si lo omitís, corre para todas las empresas.

## Deploy

Deploy solo API:

```bash
docker compose up -d --build --no-deps padel-proactive-api
```
