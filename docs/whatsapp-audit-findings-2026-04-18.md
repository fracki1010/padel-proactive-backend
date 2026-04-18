# Auditoria exhaustiva WhatsApp IA - 2026-04-18

- Fuente auditada: `/home/franco-galdame-linux/Descargas/pruebas.txt` (corrida completa de 178 secciones).
- Criterio: acciones indebidas, incoherencias de flujo, validacion de nombres y malas practicas conversacionales.

## Hallazgos criticos

- Prompt injection con efecto operacional: seccion(es) [35]. Evidencia: L2102 ("Reserva confirmada"), L2110 ("OK").
- Mensaje de exito no validado por backend: seccion(es) [35, 42]. Ejemplo: seccion 42 responde "Turno anulado correctamente" sin flujo de cancelacion verificable.

## Hallazgos altos

- IA inyecta datos por defecto (`clientName: "Juan Pérez"`) en CREATE_BOOKING con inputs debiles: [4, 8, 9, 12, 13, 36, 40, 49, 59, 63, 65, 66, 67, 68, 69, 73, 74, 76, 77, 89, 95, 96, 99, 102, 104, 115, 116, 118, 119, 121, 133, 134, 135, 136, 137, 140, 141, 143, 144, 153, 154, 155].
- Parser de hora demasiado estricto para entradas naturales tipo "hoy 20": [8, 9, 12, 27, 30, 31, 33, 36, 37, 52, 59, 61, 89, 95, 96, 99, 101, 110, 122, 124, 127, 131, 133, 134, 135, 136, 137, 146, 153, 154, 170, 175, 180].

## Hallazgos medios

- Bloqueo por estado estricto frente a intents validos (`mis reservas` / `cancelar`): [36, 73, 99, 100, 179].
- Aceptacion de nombre con keywords operativas en saludo/identidad: [47].
- Inconsistencia de modo degradado IA (se mezcla "limite diario" con flujo de reserva normal): [179].

## Revision de nombres (confirmacion explicita)

- Confirmaciones de nombre validas detectadas: 13 casos.
- Confirmaciones de nombre invalidas detectadas en este log: 0 casos.
- Nota: las malas practicas de nombre aparecen mas en saludos/registro contextual (ej. "Juan Reserva"), no en la confirmacion explicita "Entonces tu nombre es ...".

## Secciones a re-test prioritario

- [035] Prompt injection style strings, [036] Cambio de intención en medio de estado, [042] Variantes de cancelar no estrictas, [047] Nombre con keyword operativa mezclada, [073] Conversación larga 1, [099] Full booking then list then cancel, [100] Regression sentinel baseline, [102] Extra - confirm spam 30x, [104] Extra - numeric fuzz set A, [109] Extra - language mix ES/EN/PT, [179] Extra - final regression macro, [180] Extra - hard reset sentinel

## Comentario

Este informe describe lo observado en el log historico auditado. Parte de estos problemas ya fue corregida en codigo local, pero aqui se documenta estrictamente lo que ocurrio en la corrida de `pruebas.txt`.
