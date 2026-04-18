# Estabilidad rerun WhatsApp defensivo - 2026-04-18

- Base: `docs/pruebas-after-2026-04-18.txt`
- Rerun: `docs/pruebas-after-rerun-2026-04-18.txt`
- Secciones comparadas: 178
- Secciones con diferencias: 3

## Delta global de marcadores

- `ASK_FULL_NAME`: 54 -> 52
- `BOOKING_CONFIRMED`: 1 -> 0
- `OK`: 620 -> 628
- `STRICT_PROMPT`: 12 -> 7

## Secciones con diferencia

- [005] Disponibilidad simple
  - Base: [05] Disponibilidad simple | mensajes=5 | errores=0 | OK:3, STRICT_PROMPT:1, ASK_FULL_NAME:1
  - Rerun: [05] Disponibilidad simple | mensajes=5 | errores=0 | OK:5
- [011] Confirmación oferta estricta - ruido
  - Base: [11] Confirmación oferta estricta - ruido | mensajes=6 | errores=0 | OK:1, STRICT_PROMPT:4, ASK_FULL_NAME:1
  - Rerun: [11] Confirmación oferta estricta - ruido | mensajes=6 | errores=0 | OK:6
- [012] Confirmación extra estricta - ruido
  - Base: [12] Confirmación extra estricta - ruido | mensajes=9 | errores=0 | ASK_FULL_NAME:1, OK:6, STRICT_PROMPT:1, BOOKING_CONFIRMED:1
  - Rerun: [12] Confirmación extra estricta - ruido | mensajes=9 | errores=0 | ASK_FULL_NAME:1, OK:7, STRICT_PROMPT:1

## Nota

Si hay variacion en RATE_LIMIT_BLOCKED/OK entre corridas, suele deberse a condiciones de entorno (429/Service Degraded) y no necesariamente a regresion de logica.
