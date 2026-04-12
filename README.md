# padel-Padexa

## Frontend y backend separados

- Frontend (Firebase): usa `../padel-proactive-frontend/.env.example` y define `VITE_API_URL` con la URL publica del backend.
- Backend (Debian/Railway): usa `.env.production.example` y define `CORS_ORIGIN` con el dominio del frontend.

### Desarrollo local por separado

1. Backend: `npm run dev`
2. Frontend: `cd ../padel-proactive-frontend && npm run dev`
