#!/usr/bin/env node
require("dotenv").config();

// En modo QA no necesitamos Redis. Si falla, la cola cae a MongoDB silenciosamente.
// Debe setearse ANTES de cargar whatsappCommandQueue.service (lo lee al inicializarse).
process.env.WHATSAPP_ALLOW_MONGO_FALLBACK = "true";

const fs = require("fs");
const path = require("path");
const connectDB = require("../config/database");
const { closeDB } = require("../config/database");
const sessionService = require("../services/sessionService");
const groqService = require("../services/groqService");
const { handleIncomingMessage } = require("../handlers/messageHandler");

const DEFAULT_FILE = path.join(
  __dirname,
  "..",
  "..",
  "docs",
  "qa-master-test-suite.txt",
);

// ── terminal colors ──────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};
const color = (c, text) => `${c}${text}${C.reset}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── arg parser ───────────────────────────────────────────────
const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    file: process.env.WA_TEST_MESSAGES_FILE || DEFAULT_FILE,
    delayMs: Number(process.env.WA_TEST_DELAY_MS || 250),
    sectionDelayMs: Number(process.env.WA_TEST_SECTION_DELAY_MS || 120000),
    companyId: process.env.WA_TEST_COMPANY_ID || null,
    chatBase: process.env.WA_TEST_CHAT_BASE || "qa-suite",
    sameSession: false,
    section: null,
    fromSection: null,
    toSection: null,
    strictAssertions:
      String(process.env.WA_TEST_STRICT_ASSERTIONS || "false")
        .trim()
        .toLowerCase() === "true",
    reportFile: process.env.WA_TEST_REPORT_FILE || "",
    maxAiCalls: process.env.WA_TEST_MAX_AI_CALLS
      ? Number(process.env.WA_TEST_MAX_AI_CALLS)
      : null,
    noDelay: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--file" && args[i + 1]) { options.file = args[i + 1]; i += 1; continue; }
    if (arg === "--delay-ms" && args[i + 1]) { options.delayMs = Number(args[i + 1]); i += 1; continue; }
    if (arg === "--section-delay-ms" && args[i + 1]) { options.sectionDelayMs = Number(args[i + 1]); i += 1; continue; }
    if (arg === "--company-id" && args[i + 1]) { options.companyId = args[i + 1]; i += 1; continue; }
    if (arg === "--chat-base" && args[i + 1]) { options.chatBase = args[i + 1]; i += 1; continue; }
    if (arg === "--section" && args[i + 1]) { options.section = Number(args[i + 1]); i += 1; continue; }
    if (arg === "--from" && args[i + 1]) { options.fromSection = Number(args[i + 1]); i += 1; continue; }
    if (arg === "--to" && args[i + 1]) { options.toSection = Number(args[i + 1]); i += 1; continue; }
    if (arg === "--same-session") { options.sameSession = true; continue; }
    if (arg === "--strict-assertions") { options.strictAssertions = true; continue; }
    if (arg === "--report-file" && args[i + 1]) { options.reportFile = args[i + 1]; i += 1; continue; }
    if (arg === "--max-ai-calls" && args[i + 1]) { options.maxAiCalls = Number(args[i + 1]); i += 1; continue; }
    if (arg === "--no-delay") { options.noDelay = true; continue; }
  }

  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) options.delayMs = 250;
  if (!Number.isFinite(options.sectionDelayMs) || options.sectionDelayMs < 0) options.sectionDelayMs = 120000;
  if (options.noDelay) { options.delayMs = 0; options.sectionDelayMs = 0; }

  return options;
};

// ── format detection ─────────────────────────────────────────
const detectFileFormat = (rawText) => {
  if (/^===\s*\[/m.test(rawText) || /^#\s*SECCIÓN\s+\d+/m.test(rawText)) {
    return "new";
  }
  return "legacy";
};

// ── NEW FORMAT parser ─────────────────────────────────────────
// Parses the qa-master-test-suite.txt format:
//   # SECCIÓN N — Title           → major section (1-20)
//   === [S-01](*) Title ===       → block header
//   ➡️  [S-01.1] USER: message    → user turn
//   ⬅️  [S-01.1] BOT: [PASS] ... → expected pattern
const parseSectionsNewFormat = (rawText) => {
  const lines = rawText.split(/\r?\n/);
  const majorSections = [];
  let currentMajor = null;
  let currentBlock = null;

  const flushBlock = () => {
    if (currentBlock && currentBlock.messages.length > 0 && currentMajor) {
      currentMajor.blocks.push(currentBlock);
    }
    currentBlock = null;
  };

  const flushMajor = () => {
    flushBlock();
    if (currentMajor && currentMajor.blocks.length > 0) {
      majorSections.push(currentMajor);
    }
    currentMajor = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Major section: # SECCIÓN N — Title
    const majorMatch = line.match(/^#\s*SECCIÓN\s+(\d+)\s+[—-]+\s*(.+)$/);
    if (majorMatch) {
      flushMajor();
      currentMajor = {
        sectionNum: Number(majorMatch[1]),
        title: majorMatch[2].replace(/[═=]/g, "").trim(),
        blocks: [],
      };
      continue;
    }

    // Skip all comment lines (except they were already handled above)
    if (line.startsWith("#")) continue;
    if (!line) continue;

    // Block header: === [ID](*) Title ===
    const blockMatch = line.match(/^===\s*\[([^\]]+)\](\(\*\))?\s*(.+?)\s*===$/);
    if (blockMatch) {
      flushBlock();
      if (!currentMajor) {
        // fallback if no major section declared yet
        currentMajor = { sectionNum: 0, title: "Uncategorized", blocks: [] };
      }
      currentBlock = {
        id: blockMatch[1].trim(),
        critical: !!blockMatch[2],
        title: blockMatch[3].trim(),
        messages: [],
        expectations: [],
      };
      continue;
    }

    if (!currentBlock) continue;

    // User message: ➡️  [ID] USER: text
    const userMatch = rawLine.match(/➡️\s+\[[^\]]+\]\s+USER:\s*(.+)$/u);
    if (userMatch) {
      currentBlock.messages.push(userMatch[1].trim());
      currentBlock.expectations.push(null);
      continue;
    }

    // Bot expected: ⬅️  [ID] BOT: pattern
    const botMatch = rawLine.match(/⬅️\s+\[[^\]]+\]\s+BOT:\s*(.+)$/u);
    if (botMatch && currentBlock.expectations.length > 0) {
      currentBlock.expectations[currentBlock.expectations.length - 1] = botMatch[1].trim();
      continue;
    }
  }

  flushMajor();
  return majorSections;
};

// ── LEGACY FORMAT parser (backward compat) ───────────────────
const parseSectionsLegacyFormat = (rawText) => {
  const lines = String(rawText || "").split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^\[(\d+)\]\s*(.+)$/);
    if (match) {
      if (current && current.messages.length > 0) sections.push(current);
      current = {
        id: match[1],
        title: match[2].trim() || `Seccion ${match[1]}`,
        messages: [],
        expectations: [],
      };
      continue;
    }

    if (!current) continue;
    current.messages.push(rawLine);
    current.expectations.push(null);
  }

  if (current && current.messages.length > 0) sections.push(current);
  return sections;
};

// ── assertion helpers ────────────────────────────────────────
const checkAssertion = (replyText, expectedPattern) => {
  if (!expectedPattern) return { pass: true, tag: "NO_EXPECTATION" };
  const reply = String(replyText || "").trim();
  const tag = expectedPattern.match(/^\[([A-Z_]+)\]/)?.[1] || "NO_TAG";

  if (tag === "PASS") {
    return { pass: reply.length > 0, tag, note: reply.length === 0 ? "BOT did not reply" : "" };
  }
  if (tag === "EMPTY") {
    return { pass: reply.length === 0, tag, note: reply.length > 0 ? "BOT replied (should be silent)" : "" };
  }
  if (tag === "ANY") {
    return { pass: true, tag };
  }
  if (tag === "BLOCK") {
    // Can't auto-verify — human must check
    return { pass: null, tag, note: "Manual check required" };
  }
  return { pass: true, tag };
};

const summarizeReply = (replyText = "") => {
  const text = String(replyText || "");
  if (/^\s*⚠️ Estoy recibiendo demasiados mensajes seguidos/i.test(text)) return "RATE_LIMIT_BLOCKED";
  if (/\[BotSecurity\]/i.test(text)) return "SECURITY_LOGGED";
  if (/respond[eé]\s+exactamente/i.test(text)) return "STRICT_PROMPT";
  if (/necesito tu \*nombre completo\*/i.test(text)) return "ASK_FULL_NAME";
  if (/reserva confirmada/i.test(text)) return "BOOKING_CONFIRMED";
  if (/turno cancelado/i.test(text)) return "BOOKING_CANCELLED";
  if (/no encontré/i.test(text)) return "NOT_FOUND";
  if (/límite diario de consultas/i.test(text)) return "GROQ_DEGRADED";
  if (text.startsWith("ERROR:")) return "ERROR";
  return "OK";
};

// ── audit helpers (legacy behavior kept) ─────────────────────
const isValidObjectId = (id) => /^[a-f\d]{24}$/i.test(String(id || ""));

const hasBookingIntent = (text = "") =>
  /(quiero reservar|reservame|resérvame|anotame|agendame|haceme la reserva|hace la reserva)/i.test(String(text || ""));

const hasConfirmationPrompt = (text = "") =>
  /(confirmar reserva|te lo reservo|_¿te lo reservo\?_)/i.test(String(text || ""));

const hasNoAvailabilityReply = (text = "") =>
  /(no tengo disponibilidad|no tengo \*\d+\s+canchas\*|ese horario no tiene disponibilidad)/i.test(String(text || ""));

const hasBookingConfirmedReply = (text = "") =>
  /(reserva confirmada|✅ \*¡reserva confirmada!\*|✅\s*\*reserva confirmada\*)/i.test(String(text || ""));

const extractTimeFromText = (text = "") => {
  const match = String(text || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  return match ? `${String(match[1]).padStart(2, "0")}:${match[2]}` : "";
};

const extractDateTokenFromText = (text = "") => {
  const raw = String(text || "");
  const iso = raw.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const dmy = raw.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/);
  return dmy ? dmy[0] : "";
};

const buildSlotToken = ({ dateToken = "", time = "" }) =>
  `${String(dateToken || "").trim()}|${String(time || "").trim()}`;

const createSectionAudit = () => ({
  confirmed: false,
  confirmedAt: -1,
  bookingIntentAfterConfirmation: false,
  blockedSlots: [],
  lastUserRequestedTime: "",
  violations: [],
});

const auditUserTurn = (audit, userMessage = "") => {
  const text = String(userMessage || "");
  const msgTime = extractTimeFromText(text);
  if (msgTime) audit.lastUserRequestedTime = msgTime;
  if (audit.confirmed && hasBookingIntent(text)) audit.bookingIntentAfterConfirmation = true;
};

const auditBotTurn = (audit, replyText = "", context = {}) => {
  const text = String(replyText || "");
  const botTime = extractTimeFromText(text);
  const botDateToken = extractDateTokenFromText(text);
  const messageIndex = Number(context.messageIndex || 0);
  const sectionId = String(context.sectionId || "");

  if (hasNoAvailabilityReply(text)) {
    const token = buildSlotToken({ dateToken: botDateToken, time: botTime || audit.lastUserRequestedTime || "" });
    if (token !== "|") audit.blockedSlots.push({ token, sectionId, messageIndex, raw: text });
  }

  if (hasBookingConfirmedReply(text)) {
    const confirmedToken = buildSlotToken({ dateToken: botDateToken, time: botTime || audit.lastUserRequestedTime || "" });
    const conflictingBlocked = audit.blockedSlots.find(
      (item) => item.token === confirmedToken && item.token !== "|",
    );
    if (conflictingBlocked) {
      audit.violations.push({ type: "BOOKING_CONFIRMED_ON_PREVIOUSLY_REJECTED_SLOT", sectionId, messageIndex, slot: confirmedToken });
    }
    audit.confirmed = true;
    audit.confirmedAt = messageIndex;
    audit.bookingIntentAfterConfirmation = false;
  }

  if (audit.confirmed && !audit.bookingIntentAfterConfirmation && hasConfirmationPrompt(text)) {
    audit.violations.push({ type: "PROMPTED_CONFIRM_RESERVA_AFTER_ALREADY_CONFIRMED", sectionId, messageIndex });
  }
};

// ── run one block of tests ────────────────────────────────────
const runBlock = async (block, chatId, companyId, delayMs, sectionAudit) => {
  const result = {
    id: block.id,
    critical: block.critical,
    title: block.title,
    sent: 0,
    errors: 0,
    assertFails: 0,
    manualChecks: 0,
    markers: {},
    violations: [],
  };

  const label = block.critical
    ? color(C.bold + C.yellow, `[${block.id}](*) ${block.title}`)
    : color(C.cyan, `[${block.id}] ${block.title}`);
  process.stdout.write(`\n  ${label}\n`);

  for (let i = 0; i < block.messages.length; i += 1) {
    const userMessage = String(block.messages[i] || "");
    const expected = block.expectations[i] || null;
    if (!userMessage) continue;

    result.sent += 1;
    auditUserTurn(sectionAudit, userMessage);
    process.stdout.write(color(C.blue, `    ➡️  USER: ${userMessage}`) + "\n");

    let replyText = "";
    try {
      replyText = await handleIncomingMessage(chatId, userMessage, {
        companyId: companyId || null,
        client: null,
      });
    } catch (error) {
      result.errors += 1;
      replyText = `ERROR: ${error?.message || error}`;
    }

    const marker = summarizeReply(replyText);
    result.markers[marker] = (result.markers[marker] || 0) + 1;
    auditBotTurn(sectionAudit, replyText, { sectionId: block.id, messageIndex: i + 1 });

    // Determine reply color by marker
    let replyColor = C.white;
    if (marker === "ERROR") replyColor = C.red;
    else if (marker === "BOOKING_CONFIRMED") replyColor = C.green;
    else if (marker === "RATE_LIMIT_BLOCKED") replyColor = C.yellow;
    else if (marker === "SECURITY_LOGGED") replyColor = C.magenta;

    process.stdout.write(color(replyColor, `    ⬅️  BOT:  ${replyText}`) + "\n");

    // Assertion display
    if (expected) {
      const { pass, tag, note } = checkAssertion(replyText, expected);
      if (pass === true) {
        process.stdout.write(color(C.gray, `         ✓ ${tag} — ${expected}`) + "\n");
      } else if (pass === false) {
        result.assertFails += 1;
        process.stdout.write(color(C.red, `         ✗ ${tag} FAIL${note ? ` — ${note}` : ""} — expected: ${expected}`) + "\n");
      } else {
        // null → manual check
        result.manualChecks += 1;
        process.stdout.write(color(C.gray, `         ? ${tag} (manual) — ${expected}`) + "\n");
      }
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  result.violations = sectionAudit.violations.slice();
  return result;
};

// ── main ──────────────────────────────────────────────────────
const run = async () => {
  const options = parseArgs();

  if (options.companyId && !isValidObjectId(options.companyId)) {
    console.error(`❌ companyId inválido: "${options.companyId}"`);
    process.exit(1);
  }

  if (!fs.existsSync(options.file)) {
    console.error(`❌ No existe archivo: ${options.file}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(options.file, "utf8");
  const format = detectFileFormat(raw);

  // ── parse ────────────────────────────────────────────────────
  let sectionsToRun = [];

  if (format === "new") {
    const allMajorSections = parseSectionsNewFormat(raw);

    let filtered = allMajorSections;
    if (options.section !== null) {
      filtered = allMajorSections.filter((s) => s.sectionNum === options.section);
    } else if (options.fromSection !== null || options.toSection !== null) {
      const from = options.fromSection ?? 1;
      const to = options.toSection ?? allMajorSections.length;
      filtered = allMajorSections.filter((s) => s.sectionNum >= from && s.sectionNum <= to);
    }

    if (!filtered.length) {
      console.error("❌ No encontré secciones para ejecutar en ese rango.");
      process.exit(1);
    }

    // flatten to runnable list: each major section becomes one "run unit"
    sectionsToRun = filtered;
  } else {
    // legacy: wrap all blocks in one pseudo-section
    const allBlocks = parseSectionsLegacyFormat(raw);
    let filtered = allBlocks;
    if (options.section !== null) {
      filtered = allBlocks.filter((b) => String(b.id) === String(options.section));
    } else if (options.fromSection !== null || options.toSection !== null) {
      const from = options.fromSection ?? 1;
      const to = options.toSection ?? allBlocks.length;
      filtered = allBlocks.filter((b) => {
        const n = Number(b.id);
        return n >= from && n <= to;
      });
    }
    sectionsToRun = [{ sectionNum: 1, title: "Legacy Test Suite", blocks: filtered }];
  }

  // ── summary header ────────────────────────────────────────────
  const totalBlocks = sectionsToRun.reduce((acc, s) => acc + s.blocks.length, 0);
  const totalMessages = sectionsToRun.reduce(
    (acc, s) => acc + s.blocks.reduce((a, b) => a + b.messages.length, 0), 0,
  );
  const sectionDelayMin = (options.sectionDelayMs / 60000).toFixed(1);

  console.log(color(C.bold, "\n🧪 QA Master Test Suite — Padel Proactive Bot"));
  console.log(`📄 Archivo:   ${options.file}`);
  console.log(`📂 Formato:   ${format === "new" ? "nuevo (qa-master)" : "legado"}`);
  console.log(`🏢 companyId: ${options.companyId || "(null/global)"}`);
  console.log(`⏱️  delay msg: ${options.delayMs}ms`);
  console.log(`⏸️  delay sec: ${options.sectionDelayMs}ms (${sectionDelayMin} min entre secciones)`);
  console.log(`📦 secciones: ${sectionsToRun.length} | bloques: ${totalBlocks} | mensajes: ${totalMessages}`);
  if (Number.isFinite(options.maxAiCalls)) {
    console.log(`🤖 max-ai-calls: ${options.maxAiCalls}`);
  }

  await connectDB();

  if (Number.isFinite(options.maxAiCalls) && options.maxAiCalls >= 0) {
    let aiCallCount = 0;
    const originalGetChatResponse = groqService.getChatResponse.bind(groqService);
    groqService.getChatResponse = async (...args) => {
      if (aiCallCount >= options.maxAiCalls) {
        return JSON.stringify({ action: "SERVICE_DEGRADED", retryAfterText: "modo-test" });
      }
      aiCallCount += 1;
      return originalGetChatResponse(...args);
    };
  }

  const allResults = [];
  const allViolations = [];
  const staticChatId = `${options.chatBase}:${Date.now()}`;

  try {
    for (let si = 0; si < sectionsToRun.length; si += 1) {
      const major = sectionsToRun[si];

      console.log(
        color(C.bold + C.magenta,
          `\n${"═".repeat(60)}\n  SECCIÓN ${major.sectionNum}: ${major.title}\n${"═".repeat(60)}`
        )
      );

      const sectionAudit = createSectionAudit();

      for (let bi = 0; bi < major.blocks.length; bi += 1) {
        const block = major.blocks[bi];

        const chatId = options.sameSession
          ? staticChatId
          : `${options.chatBase}:${major.sectionNum}:${block.id}:${Date.now()}`;
        const sessionId = options.companyId ? `${options.companyId}:${chatId}` : chatId;

        sessionService.clearHistory(sessionId);

        const result = await runBlock(block, chatId, options.companyId, options.delayMs, sectionAudit);
        result.violations = sectionAudit.violations.slice();
        allResults.push(result);
        allViolations.push(...result.violations);

        sessionService.clearHistory(sessionId);
      }

      const isLast = si === sectionsToRun.length - 1;
      if (options.sectionDelayMs > 0 && !isLast) {
        const next = sectionsToRun[si + 1];
        const countdown = options.sectionDelayMs / 1000;
        process.stdout.write(
          color(C.yellow,
            `\n⏸  Pausa ${sectionDelayMin} min antes de SECCIÓN ${next.sectionNum}: ${next.title}`)
          + "\n"
        );
        // show countdown every 30s
        let elapsed = 0;
        while (elapsed < options.sectionDelayMs) {
          const step = Math.min(30000, options.sectionDelayMs - elapsed);
          await sleep(step);
          elapsed += step;
          const remaining = Math.ceil((options.sectionDelayMs - elapsed) / 1000);
          if (remaining > 0) {
            process.stdout.write(color(C.gray, `     ⏳ ${remaining}s restantes...`) + "\n");
          }
        }
        process.stdout.write(color(C.green, `  ▶️  Continuando con SECCIÓN ${next.sectionNum}...`) + "\n");
      }
    }
  } finally {
    await closeDB();
  }

  // ── final summary ─────────────────────────────────────────────
  const totalErrors = allResults.reduce((acc, r) => acc + r.errors, 0);
  const totalAssertFails = allResults.reduce((acc, r) => acc + r.assertFails, 0);
  const totalManualChecks = allResults.reduce((acc, r) => acc + r.manualChecks, 0);
  const criticalWithErrors = allResults.filter((r) => r.critical && (r.errors > 0 || r.assertFails > 0));

  console.log(color(C.bold, `\n${"═".repeat(60)}\n  RESUMEN FINAL\n${"═".repeat(60)}`));

  for (const r of allResults) {
    const markersText = Object.entries(r.markers)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
    const hasProblems = r.errors > 0 || r.assertFails > 0 || r.violations.length > 0;
    const prefix = r.critical ? "(*)" : "   ";
    const lineColor = hasProblems ? C.red : r.manualChecks > 0 ? C.yellow : C.gray;
    console.log(
      color(lineColor,
        `${prefix} [${r.id}] ${r.title.padEnd(50).slice(0, 50)} | msg:${r.sent} err:${r.errors} fail:${r.assertFails} manual:${r.manualChecks} | ${markersText}`
      )
    );
    for (const v of r.violations) {
      console.log(
        color(C.red, `      ⚠️  ${v.type}@${v.sectionId}.${v.messageIndex || "?"}${v.slot ? ` slot=${v.slot}` : ""}`)
      );
    }
  }

  console.log(color(C.bold, `\n${"═".repeat(60)}`));
  console.log(`  Bloques ejecutados:  ${allResults.length}`);
  console.log(`  Errores técnicos:    ${totalErrors}`);
  console.log(color(totalAssertFails > 0 ? C.red : C.green, `  Assert FAIL:        ${totalAssertFails}`));
  console.log(color(C.yellow, `  Manual checks:      ${totalManualChecks}`));
  console.log(color(allViolations.length > 0 ? C.red : C.green, `  Violaciones audit:  ${allViolations.length}`));
  if (criticalWithErrors.length > 0) {
    console.log(color(C.bold + C.red, `\n  ❌ CRITICAL FAILURES:`));
    for (const r of criticalWithErrors) {
      console.log(color(C.red, `    [${r.id}](*) ${r.title}`));
    }
  } else {
    console.log(color(C.green, "\n  ✅ Ningún bloque crítico con errores."));
  }
  console.log(color(C.bold, "═".repeat(60)));

  // ── report file ───────────────────────────────────────────────
  if (options.reportFile) {
    const reportPath = path.resolve(options.reportFile);
    const lines = [];
    lines.push("# QA Master Suite Report");
    lines.push(`- GeneratedAt: ${new Date().toISOString()}`);
    lines.push(`- File: ${options.file}`);
    lines.push(`- Format: ${format}`);
    lines.push(`- Blocks: ${allResults.length}`);
    lines.push(`- TotalErrors: ${totalErrors}`);
    lines.push(`- AssertFails: ${totalAssertFails}`);
    lines.push(`- ManualChecks: ${totalManualChecks}`);
    lines.push(`- Violations: ${allViolations.length}`);
    lines.push("");
    for (const r of allResults) {
      lines.push(`## [${r.id}]${r.critical ? "(*)" : ""} ${r.title}`);
      lines.push(`- Sent: ${r.sent} | Errors: ${r.errors} | AssertFails: ${r.assertFails}`);
      lines.push(`- Markers: ${Object.entries(r.markers).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}`);
      if (r.violations.length) {
        lines.push("- Violations:");
        for (const v of r.violations) {
          lines.push(`  - ${v.type} @${r.id}.${v.messageIndex || "?"}${v.slot ? ` slot=${v.slot}` : ""}`);
        }
      }
      lines.push("");
    }
    fs.writeFileSync(reportPath, lines.join("\n") + "\n", "utf8");
    console.log(`\n📝 Reporte: ${reportPath}`);
  }

  if (options.strictAssertions && (allViolations.length > 0 || totalErrors > 0 || totalAssertFails > 0)) {
    console.error("❌ Fallos con --strict-assertions activo.");
    process.exit(2);
  }
};

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error ejecutando QA suite:", error);
    process.exit(1);
  });
