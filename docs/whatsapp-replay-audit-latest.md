# WhatsApp Defensive Replay Report
- GeneratedAt: 2026-04-19T22:59:34.116Z
- File: docs/whatsapp-defensive-test-messages.txt
- Sections: 178
- Violations: 0
- TotalErrors: 0

## [01] Smoke básico
- Sent: 6
- Errors: 0
- Markers: OK:5, ASK_FULL_NAME:1
- Violations: none

## [02] Reserva simple variaciones afirmativas
- Sent: 5
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:4
- Violations: none

## [03] Reserva simple con fecha ISO
- Sent: 4
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:3
- Violations: none

## [04] Reserva simple con fecha DMY
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [05] Disponibilidad simple
- Sent: 5
- Errors: 0
- Markers: OK:5
- Violations: none

## [06] Consulta reservas vigentes
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [07] Turno fijo básico
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [08] Nombre inválido cortísimo
- Sent: 7
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:6
- Violations: none

## [09] Nombre inválido con números
- Sent: 6
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:5
- Violations: none

## [10] Nombre inválido con keywords operativas
- Sent: 7
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:6
- Violations: none

## [11] Confirmación oferta estricta - ruido
- Sent: 6
- Errors: 0
- Markers: OK:6
- Violations: none

## [12] Confirmación extra estricta - ruido
- Sent: 9
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:8
- Violations: none

## [13] Drafteo múltiple 2 horarios
- Sent: 5
- Errors: 0
- Markers: OK:5
- Violations: none

## [14] Drafteo múltiple cancelación
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [15] Confirmación nombre SI/NO estricta
- Sent: 8
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:7
- Violations: none

## [16] FULL_NAME_CAPTURE - mensajes mezclados
- Sent: 6
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:5
- Violations: none

## [17] Cancelación determinística normal
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [18] Cancelación determinística variantes
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [19] Cancelación sin datos completos
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [20] Fechas relativas
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [21] Días de semana
- Sent: 7
- Errors: 0
- Markers: OK:7
- Violations: none

## [22] Horas formato válido
- Sent: 7
- Errors: 0
- Markers: OK:7
- Violations: none

## [23] Horas formato inválido
- Sent: 5
- Errors: 0
- Markers: OK:5
- Violations: none

## [24] Horario inexistente de grilla
- Sent: 2
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:1
- Violations: none

## [25] Texto largo > 280
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [27] Control chars (representación textual)
- Sent: 2
- Errors: 0
- Markers: OK:1, ASK_FULL_NAME:1
- Violations: none

## [28] Unicode raro normalización
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [29] Acentos y ñ
- Sent: 4
- Errors: 0
- Markers: OK:3, ASK_FULL_NAME:1
- Violations: none

## [30] Emojis y símbolos
- Sent: 4
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:3
- Violations: none

## [31] Markdown y backticks
- Sent: 4
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:3
- Violations: none

## [32] JSON-like payload
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [33] SQL injection style strings
- Sent: 3
- Errors: 0
- Markers: OK:2, ASK_FULL_NAME:1
- Violations: none

## [34] Command injection style strings
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [35] Prompt injection style strings
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [36] Cambio de intención en medio de estado
- Sent: 5
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:4
- Violations: none

## [37] Repetición compulsiva misma orden
- Sent: 4
- Errors: 0
- Markers: ASK_FULL_NAME:4
- Violations: none

## [38] Flood control messages 1
- Sent: 10
- Errors: 0
- Markers: OK:8, RATE_LIMIT_BLOCKED:2
- Violations: none

## [39] Flood control messages 2
- Sent: 9
- Errors: 0
- Markers: OK:8, RATE_LIMIT_BLOCKED:1
- Violations: none

## [40] Flood mixed intent
- Sent: 10
- Errors: 0
- Markers: OK:9, ASK_FULL_NAME:1
- Violations: none

## [41] Doble significado natural language
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [42] Variantes de cancelar no estrictas
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [43] Variantes de confirmar no estrictas
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [44] Nombres compuestos válidos
- Sent: 6
- Errors: 0
- Markers: OK:6
- Violations: none

## [45] Nombres con guión/apóstrofe
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [46] Nombres placeholders
- Sent: 5
- Errors: 0
- Markers: OK:5
- Violations: none

## [47] Nombre con keyword operativa mezclada
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [48] Día + periodo mañana/tarde/noche
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [49] Mensajes cortados por partes
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [50] Mensajes con muchas mayúsculas
- Sent: 4
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:3
- Violations: none

## [51] Mensajes con puntuación excesiva
- Sent: 4
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:3
- Violations: none

## [52] Mensajes con separadores extraños
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [53] Horas compactas
- Sent: 3
- Errors: 0
- Markers: ASK_FULL_NAME:3
- Violations: none

## [54] Fechas ambiguas
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [55] Timezone confusion
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [56] Reserva pasada (si aplica)
- Sent: 1
- Errors: 0
- Markers: ASK_FULL_NAME:1
- Violations: none

## [57] Cancelación ventana bloqueada (si aplica)
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [58] Mensajes duplicados rápidos
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [59] Conversación de distracción durante estado estricto
- Sent: 6
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:5
- Violations: none

## [60] Mezcla consulta + reserva + cancelación en 1
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [61] Texto con links
- Sent: 3
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:2
- Violations: none

## [62] Texto con email/telefono
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [63] Respuesta attendance solo 1/2
- Sent: 6
- Errors: 0
- Markers: OK:6
- Violations: none

## [64] Confirmación de nombre con ruido
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [65] Draft confirmation letras fuera de rango
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [66] Intento bypass con espacios
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [67] Intento bypass con acentos
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [68] Intento bypass con homoglyphs
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [69] Reanudación tras rate limit
- Sent: 10
- Errors: 0
- Markers: OK:9, RATE_LIMIT_BLOCKED:1
- Violations: none

## [70] Mensajes aleatorios 1
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [71] Mensajes aleatorios 2
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [72] Mensajes aleatorios 3
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [73] Conversación larga 1
- Sent: 10
- Errors: 0
- Markers: OK:10
- Violations: none

## [74] Conversación larga 2
- Sent: 9
- Errors: 0
- Markers: OK:6, ASK_FULL_NAME:1, BOOKING_CONFIRMED:1, BOOKING_CANCELLED:1
- Violations: none

## [75] Cancelar fuera de estado
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [76] Confirmar fuera de estado
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [77] Case sensitivity full
- Sent: 5
- Errors: 0
- Markers: OK:5
- Violations: none

## [78] Availability with no time
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [79] Availability with period + no time
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [80] Availability with exact seconds (invalid)
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [81] Massive whitespace around name
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [82] Name with multiple surnames
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [83] Name edge apostrophe + accent
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [84] Name with forbidden punctuation
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [85] Mixed language
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [86] Phishing-like text
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [87] Very short bursts
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [88] Numeric only intents
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [89] Duplicate same minute booking attempts
- Sent: 6
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:5
- Violations: none

## [90] Booking with explicit court mention
- Sent: 4
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:3
- Violations: none

## [91] Bad court mention
- Sent: 2
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:1
- Violations: none

## [92] Cancel booking not found
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [93] Cancel booking invalid time
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [94] Multi-action JSON-like
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [95] Leading/trailing punctuation
- Sent: 4
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:3
- Violations: none

## [96] Bot strict-state poisoning attempt
- Sent: 5
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:4
- Violations: none

## [97] Try to overwrite identity
- Sent: 6
- Errors: 0
- Markers: OK:6
- Violations: none

## [98] Full cancel flow then new booking
- Sent: 5
- Errors: 0
- Markers: OK:4, ASK_FULL_NAME:1
- Violations: none

## [99] Full booking then list then cancel
- Sent: 6
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:5
- Violations: none

## [100] Regression sentinel baseline
- Sent: 7
- Errors: 0
- Markers: OK:6, ASK_FULL_NAME:1
- Violations: none

## [101] Extra - mismo texto repetido 20x
- Sent: 20
- Errors: 0
- Markers: ASK_FULL_NAME:8, RATE_LIMIT_BLOCKED:12
- Violations: none

## [102] Extra - confirm spam 30x
- Sent: 30
- Errors: 0
- Markers: OK:8, RATE_LIMIT_BLOCKED:22
- Violations: none

## [103] Extra - cancel spam 30x
- Sent: 30
- Errors: 0
- Markers: OK:8, RATE_LIMIT_BLOCKED:22
- Violations: none

## [104] Extra - numeric fuzz set A
- Sent: 20
- Errors: 0
- Markers: OK:14, RATE_LIMIT_BLOCKED:6
- Violations: none

## [105] Extra - numeric fuzz set B
- Sent: 10
- Errors: 0
- Markers: OK:10
- Violations: none

## [106] Extra - date fuzz set A
- Sent: 7
- Errors: 0
- Markers: OK:7
- Violations: none

## [107] Extra - date fuzz set B
- Sent: 7
- Errors: 0
- Markers: OK:7
- Violations: none

## [108] Extra - locale date words
- Sent: 7
- Errors: 0
- Markers: OK:7
- Violations: none

## [109] Extra - language mix ES/EN/PT
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [110] Extra - malformed UTF samples
- Sent: 3
- Errors: 0
- Markers: OK:2, ASK_FULL_NAME:1
- Violations: none

## [111] Extra - punctuation flood
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [112] Extra - symbol flood
- Sent: 5
- Errors: 0
- Markers: OK:5
- Violations: none

## [113] Extra - slash/backslash chaos
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [114] Extra - bracket chaos
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [115] Extra - keyword permutations
- Sent: 6
- Errors: 0
- Markers: OK:6
- Violations: none

## [116] Extra - near miss confirmations
- Sent: 5
- Errors: 0
- Markers: OK:5
- Violations: none

## [117] Extra - near miss cancellations
- Sent: 5
- Errors: 0
- Markers: OK:5
- Violations: none

## [118] Extra - whitespace hard cases
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [119] Extra - homoglyph variants 1
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [120] Extra - homoglyph variants 2
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [121] Extra - markdown injection style
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [122] Extra - html-like payload
- Sent: 3
- Errors: 0
- Markers: OK:2, ASK_FULL_NAME:1
- Violations: none

## [123] Extra - xml-like payload
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [124] Extra - escaped strings
- Sent: 3
- Errors: 0
- Markers: OK:2, ASK_FULL_NAME:1
- Violations: none

## [125] Extra - phone-like noise
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [126] Extra - email-like noise
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [127] Extra - URL noise
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [128] Extra - multi-command one line A
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [129] Extra - multi-command one line B
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [130] Extra - multi-command one line C
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [131] Extra - typo tolerant check
- Sent: 3
- Errors: 0
- Markers: OK:2, ASK_FULL_NAME:1
- Violations: none

## [132] Extra - typo in name capture
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [133] Extra - sequenced valid booking 1
- Sent: 4
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:3
- Violations: none

## [134] Extra - sequenced valid booking 2
- Sent: 4
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:3
- Violations: none

## [135] Extra - same user tries third booking
- Sent: 3
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:2
- Violations: none

## [136] Extra - forced cancel from strict state
- Sent: 3
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:2
- Violations: none

## [137] Extra - strict state irrelevant question
- Sent: 6
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:5
- Violations: none

## [138] Extra - yes/no false positives
- Sent: 6
- Errors: 0
- Markers: OK:6
- Violations: none

## [139] Extra - attendance false positives
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [140] Extra - draft invalid letters
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [141] Extra - draft lower/upper cases
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [142] Extra - interval bursts 1
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [143] Extra - interval bursts 2
- Sent: 5
- Errors: 0
- Markers: OK:5
- Violations: none

## [144] Extra - non-latin scripts
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [145] Extra - rtl script samples
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [146] Extra - emoji heavy
- Sent: 3
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:2
- Violations: none

## [147] Extra - ascii control visual tokens
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [148] Extra - repeating name changes
- Sent: 6
- Errors: 0
- Markers: OK:6
- Violations: none

## [149] Extra - name with particles
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [150] Extra - name invalid one-word
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [151] Extra - name invalid with symbols
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [152] Extra - edge long but under 280
- Sent: 1
- Errors: 0
- Markers: ASK_FULL_NAME:1
- Violations: none

## [153] Extra - multiple spaces all tokens
- Sent: 4
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:3
- Violations: none

## [154] Extra - order inversion
- Sent: 4
- Errors: 0
- Markers: OK:3, ASK_FULL_NAME:1
- Violations: none

## [155] Extra - order inversion 2
- Sent: 4
- Errors: 0
- Markers: OK:3, ASK_FULL_NAME:1
- Violations: none

## [156] Extra - cancellation then confirmation
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [157] Extra - availability then cancel token
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [158] Extra - fallback parser stress A
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [159] Extra - fallback parser stress B
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [160] Extra - fallback parser stress C
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [161] Extra - fixed turn with details
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [162] Extra - fixed turn with malformed details
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [163] Extra - cancel old style phrase
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [164] Extra - cancel ambiguous no time
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [165] Extra - malicious persuasion
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [166] Extra - malicious roleplay
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [168] Extra - fake JSON arrays
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [169] Extra - fake YAML
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [170] Extra - conversation drift 1
- Sent: 4
- Errors: 0
- Markers: OK:3, ASK_FULL_NAME:1
- Violations: none

## [171] Extra - conversation drift 2
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [172] Extra - repeated list requests
- Sent: 4
- Errors: 0
- Markers: OK:4
- Violations: none

## [173] Extra - simultaneous intents long
- Sent: 1
- Errors: 0
- Markers: OK:1
- Violations: none

## [174] Extra - with commas in date/time
- Sent: 2
- Errors: 0
- Markers: ASK_FULL_NAME:1, OK:1
- Violations: none

## [175] Extra - malformed separators
- Sent: 3
- Errors: 0
- Markers: OK:2, ASK_FULL_NAME:1
- Violations: none

## [176] Extra - binary-like chunk
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [177] Extra - random alpha burst
- Sent: 3
- Errors: 0
- Markers: OK:3
- Violations: none

## [178] Extra - random multilingual burst
- Sent: 2
- Errors: 0
- Markers: OK:2
- Violations: none

## [179] Extra - final regression macro
- Sent: 7
- Errors: 0
- Markers: OK:6, ASK_FULL_NAME:1
- Violations: none

## [180] Extra - hard reset sentinel
- Sent: 5
- Errors: 0
- Markers: OK:4, ASK_FULL_NAME:1
- Violations: none

