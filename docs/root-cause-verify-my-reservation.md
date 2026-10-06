# Root cause — "el bot no reconoce MI reserva" (flujo WhatsApp PADEXA)

Caso real reportado:

1. Cliente: "Quiero saber si mi reserva está confirmada" → Bot: "Decime fecha y hora"
2. Cliente: "6/10 18:30" → Bot: "No entendí…"
3. Cliente: "Hoy 6 de octubre horario 18:30hs" → Bot: "No entendí…"
4. Cliente: "Mi reserva" → Bot: "Para reservar necesito el día y la hora"
5. Cliente: "Hoy a las 18:30" → Bot: "¿Techada o Descubierta?" (disponibilidad)

El cliente SÍ tenía una reserva en esa fecha/hora y el bot nunca la conectó.

## Causa 1 — El matcher de `LIST_ACTIVE_BOOKINGS` no cubre "mi reserva" ni frases de verificación

`src/whatsapp/domain/messageInterpreter.js:75-79` — el regex de reservas propias cubre
formas plurales y coloquiales ("mis reservas", "tengo turnos", "que turnos tengo") pero NO las
formas singulares ni las frases de verificación que usó el cliente:

- "mi reserva" (singular) → NO matchea (`mis reservas` ≠ `mi reserva`)
- "quiero saber si mi reserva está confirmada" → NO matchea
- "está confirmada mi reserva" / "verificar mi reserva" → NO matchean

Como consecuencia, "Quiero saber si mi reserva está confirmada" cae al regex genérico de
confirmación `messageInterpreter.js:103` — `\b(si|ok|dale|confirmar|confirmado|confirmo|…)\b`
— por el token suelto **"si"**, y el flujo no lo asocia jamás con las reservas del cliente.
El bot termina respondiendo "Decime fecha y hora" (vía IA, sin vínculo con la reserva real).

## Causa 2 — "Mi reserva" cae a CREATE_BOOKING por el regex genérico de "reserva"

`messageInterpreter.js:107` — el regex de creación `\b(reservar|reserva|quiero reservar|…)\b`
atrapa "mi reserva" porque contiene la palabra **"reserva"**.

Luego `messageHandler.js:2583` evalúa `hasDirectBookingIntent("mi reserva")` — que en
`src/whatsapp/domain/intentDetection.js:132-144` exige el VERBO (`reservar|anotame|agendame|…`)
— y da `false`. El flujo entra en la rama `!canCreateBookingFromMessage`
(`messageHandler.js:2583-2613`) y, sin fecha ni hora, responde exactamente:

> "Para reservar necesito el día y la hora del turno." (`messageHandler.js:2608-2609`)

Reproducción textual del mensaje 4 del caso real.

## Causa 3 — Una fecha+hora pelada ("6/10 18:30") no tiene intent determinístico

`detectIntent` devuelve `UNKNOWN` (`messageInterpreter.js:117`) para "6/10 18:30" y
"Hoy 6 de octubre horario 18:30hs": no hay keyword de reserva/disponibilidad ni de "los míos"
que las clasifique; `inferFallbackAction` (`intentDetection.js:19-62`) tampoco las captura.
El mensaje cae a la IA (`messageHandler.js:2344-2350`), que no tiene contexto de que la
fecha/hora se refiere a la reserva propia → responde "No entendí…".

Además, el parser local `extractTimeFromMessage` devuelve `06:00` para
"Hoy 6 de octubre horario 18:30hs" (el token "horario" interfiere) — otro síntoma de que la
clasificación de intención nunca se apoya en el cruce contra reservas existentes.

## Causa 4 — CHECK_AVAILABILITY / CREATE_BOOKING NUNCA cruzan con las reservas del cliente

`messageHandler.js:2719-2763` (disponibilidad) y `messageHandler.js:2498-2691` (reserva):

- El flujo consulta SOLO la disponibilidad del club: `bookingService.getAvailableSlots`
  (`src/services/bookingService.js:493-588`) — examina `Booking` del club por slot, sin mirar
  quién es el cliente.
- `buildAvailabilityResponse` (`messageHandler.js:477+`) sugiere canchas/tipos ('¿Techada o
  Descubierta?' — mensaje 5) sin verificar si el cliente YA tiene ese turno.
- La única lógica que recupera reservas del cliente es `getActiveBookingsForClient`
  (`src/services/bookingService.js:396-488`) y se usa exclusivamente en los caminos de
  LIST_ACTIVE_BOOKINGS (`messageHandler.js:2444-2453`, `2700-2717`, `2766-2778`) — jamás
  cuando se procesa una fecha+hora concreta para agendar/disponibilidad.

## Causa 5 — El fallback (`inferFallbackAction`) tiene su propio regex de "los míos" desincronizado

`src/whatsapp/domain/intentDetection.js:22-28` repite un regex propio de reservas propias,
también sin las formas singulares/de verificación. En modo degradado (SERVICE_DEGRADED) y en
los fallbacks de UNKNOWN (`messageHandler.js:2444-2453`, `2924-2932`, `2987-2995`) el bug se
reproduce igual.

## Conclusión

No existe ninguna regla de **prioridad de reserva existente**: cuando un intent llega a
CREATE_BOOKING o CHECK_AVAILABILITY con una fecha y hora, el bot trata al cliente como un
desconocido que quiere agendar, en vez de responderle el estado de la reserva que ya tiene
en ese mismo slot.