#!/usr/bin/env node
require("dotenv").config();

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
  "whatsapp-defensive-test-messages.txt",
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    file: process.env.WA_TEST_MESSAGES_FILE || DEFAULT_FILE,
    delayMs: Number(process.env.WA_TEST_DELAY_MS || 250),
    sectionDelayMs: Number(process.env.WA_TEST_SECTION_DELAY_MS || 0),
    companyId: process.env.WA_TEST_COMPANY_ID || null,
    chatBase: process.env.WA_TEST_CHAT_BASE || "qa-defensive",
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
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--file" && args[i + 1]) {
      options.file = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--delay-ms" && args[i + 1]) {
      options.delayMs = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--company-id" && args[i + 1]) {
      options.companyId = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--chat-base" && args[i + 1]) {
      options.chatBase = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--section" && args[i + 1]) {
      options.section = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--from" && args[i + 1]) {
      options.fromSection = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--to" && args[i + 1]) {
      options.toSection = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--same-session") {
      options.sameSession = true;
      continue;
    }
    if (arg === "--strict-assertions") {
      options.strictAssertions = true;
      continue;
    }
    if (arg === "--report-file" && args[i + 1]) {
      options.reportFile = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--max-ai-calls" && args[i + 1]) {
      options.maxAiCalls = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--section-delay-ms" && args[i + 1]) {
      options.sectionDelayMs = Number(args[i + 1]);
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    options.delayMs = 250;
  }
  if (!Number.isFinite(options.sectionDelayMs) || options.sectionDelayMs < 0) {
    options.sectionDelayMs = 0;
  }

  return options;
};

const hasBookingIntent = (text = "") =>
  /(quiero reservar|reservame|resérvame|anotame|agendame|haceme la reserva|hace la reserva)/i.test(
    String(text || ""),
  );

const hasConfirmationPrompt = (text = "") =>
  /(confirmar reserva|te lo reservo|_¿te lo reservo\?_)/i.test(
    String(text || ""),
  );

const hasNoAvailabilityReply = (text = "") =>
  /(no tengo disponibilidad|no tengo \*\d+\s+canchas\*|ese horario no tiene disponibilidad)/i.test(
    String(text || ""),
  );

const hasBookingConfirmedReply = (text = "") =>
  /(reserva confirmada|✅ \*¡reserva confirmada!\*|✅\s*\*reserva confirmada\*)/i.test(
    String(text || ""),
  );

const extractTimeFromText = (text = "") => {
  const match = String(text || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!match) return "";
  return `${String(match[1]).padStart(2, "0")}:${match[2]}`;
};

const extractDateTokenFromText = (text = "") => {
  const raw = String(text || "");
  const iso = raw.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const dmy = raw.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/);
  if (dmy) return dmy[0];
  return "";
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
  if (audit.confirmed && hasBookingIntent(text)) {
    audit.bookingIntentAfterConfirmation = true;
  }
};

const auditBotTurn = (audit, replyText = "", context = {}) => {
  const text = String(replyText || "");
  const botTime = extractTimeFromText(text);
  const botDateToken = extractDateTokenFromText(text);
  const messageIndex = Number(context.messageIndex || 0);
  const sectionId = String(context.sectionId || "");

  if (hasNoAvailabilityReply(text)) {
    const token = buildSlotToken({
      dateToken: botDateToken,
      time: botTime || audit.lastUserRequestedTime || "",
    });
    if (token !== "|") {
      audit.blockedSlots.push({
        token,
        sectionId,
        messageIndex,
        raw: text,
      });
    }
  }

  if (hasBookingConfirmedReply(text)) {
    const confirmedToken = buildSlotToken({
      dateToken: botDateToken,
      time: botTime || audit.lastUserRequestedTime || "",
    });
    const conflictingBlocked = audit.blockedSlots.find(
      (item) => item.token === confirmedToken && item.token !== "|",
    );
    if (conflictingBlocked) {
      audit.violations.push({
        type: "BOOKING_CONFIRMED_ON_PREVIOUSLY_REJECTED_SLOT",
        sectionId,
        messageIndex,
        slot: confirmedToken,
      });
    }
    audit.confirmed = true;
    audit.confirmedAt = messageIndex;
    audit.bookingIntentAfterConfirmation = false;
  }

  if (
    audit.confirmed &&
    !audit.bookingIntentAfterConfirmation &&
    hasConfirmationPrompt(text)
  ) {
    audit.violations.push({
      type: "PROMPTED_CONFIRM_RESERVA_AFTER_ALREADY_CONFIRMED",
      sectionId,
      messageIndex,
    });
  }
};

const parseSectionsFromFile = (rawText) => {
  const lines = String(rawText || "").split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^\[(\d+)\]\s*(.+)$/);
    if (match) {
      if (current && current.messages.length > 0) {
        sections.push(current);
      }
      current = {
        id: match[1],
        title: match[2].trim() || `Seccion ${match[1]}`,
        messages: [],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    current.messages.push(rawLine);
  }

  if (current && current.messages.length > 0) {
    sections.push(current);
  }

  return sections;
};

const summarizeReply = (replyText = "") => {
  const text = String(replyText || "");
  if (/^\s*⚠️ Estoy recibiendo demasiados mensajes seguidos/i.test(text)) {
    return "RATE_LIMIT_BLOCKED";
  }
  if (/\[BotSecurity\]/i.test(text)) {
    return "SECURITY_LOGGED";
  }
  if (/respond[eé]\s+exactamente/i.test(text)) {
    return "STRICT_PROMPT";
  }
  if (/necesito tu \*nombre completo\*/i.test(text)) {
    return "ASK_FULL_NAME";
  }
  if (/reserva confirmada/i.test(text)) {
    return "BOOKING_CONFIRMED";
  }
  if (/turno cancelado/i.test(text)) {
    return "BOOKING_CANCELLED";
  }
  return "OK";
};

const run = async () => {
  const options = parseArgs();

  if (!fs.existsSync(options.file)) {
    console.error(`❌ No existe archivo de casos: ${options.file}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(options.file, "utf8");
  const allSections = parseSectionsFromFile(raw);
  let sections = allSections;
  if (options.section) {
    sections = allSections.filter((item) => String(item.id) === String(options.section));
  } else if (options.fromSection !== null || options.toSection !== null) {
    const from = options.fromSection ?? 1;
    const to = options.toSection ?? allSections.length;
    sections = allSections.filter((item) => {
      const n = Number(item.id);
      return n >= from && n <= to;
    });
  }

  if (!sections.length) {
    console.error("❌ No encontré secciones de prueba para ejecutar.");
    process.exit(1);
  }

  console.log("🧪 Replay defensivo WhatsApp");
  console.log(`📄 Archivo: ${options.file}`);
  console.log(`🏢 companyId: ${options.companyId || "(null/global)"}`);
  console.log(`💬 chat base: ${options.chatBase}`);
  console.log(`⏱️ delay: ${options.delayMs}ms`);
  console.log(`🔁 same session: ${options.sameSession ? "SI" : "NO"}`);
  console.log(`📦 secciones: ${sections.length}`);
  if (Number.isFinite(options.maxAiCalls)) {
    console.log(`🤖 max-ai-calls: ${options.maxAiCalls}`);
  }

  await connectDB();

  if (Number.isFinite(options.maxAiCalls) && options.maxAiCalls >= 0) {
    console.log(`🔒 max-ai-calls: ${options.maxAiCalls} (modo básico al superarlo)`);
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

  const summary = [];
  const allViolations = [];
  const staticChatId = `${options.chatBase}:${Date.now()}`;

  try {
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      const section = sections[sectionIndex];
      const chatId = options.sameSession
        ? staticChatId
        : `${options.chatBase}:${section.id}:${Date.now()}:${sectionIndex}`;
      const sessionId = options.companyId ? `${options.companyId}:${chatId}` : chatId;

      sessionService.clearHistory(sessionId);

      console.log(`\n=== [${section.id}] ${section.title} ===`);
      const sectionResult = {
        id: section.id,
        title: section.title,
        sent: 0,
        errors: 0,
        markers: {},
        violations: [],
      };
      const sectionAudit = createSectionAudit();

      for (let i = 0; i < section.messages.length; i += 1) {
        const userMessage = String(section.messages[i] || "");
        if (!userMessage.trim()) continue;

        sectionResult.sent += 1;
        auditUserTurn(sectionAudit, userMessage);
        process.stdout.write(`➡️  [${section.id}.${i + 1}] USER: ${userMessage}\n`);

        let replyText = "";
        try {
          replyText = await handleIncomingMessage(chatId, userMessage, {
            companyId: options.companyId || null,
            client: null,
          });
        } catch (error) {
          sectionResult.errors += 1;
          replyText = `ERROR: ${error?.message || error}`;
        }

        const marker = summarizeReply(replyText);
        sectionResult.markers[marker] = (sectionResult.markers[marker] || 0) + 1;
        auditBotTurn(sectionAudit, replyText, {
          sectionId: section.id,
          messageIndex: i + 1,
        });
        process.stdout.write(`⬅️  [${section.id}.${i + 1}] BOT: ${replyText}\n`);

        if (options.delayMs > 0) {
          await sleep(options.delayMs);
        }
      }

      sectionResult.violations = sectionAudit.violations.slice();
      allViolations.push(...sectionResult.violations);

      summary.push(sectionResult);
      sessionService.clearHistory(sessionId);

      const isLastSection = sectionIndex === sections.length - 1;
      if (options.sectionDelayMs > 0 && !isLastSection) {
        const delayMin = (options.sectionDelayMs / 60000).toFixed(1);
        console.log(
          `⏸  Pausa entre secciones: ${delayMin} min. Siguiente: [${sections[sectionIndex + 1].id}] ${sections[sectionIndex + 1].title}`,
        );
        await sleep(options.sectionDelayMs);
      }
    }
  } finally {
    await closeDB();
  }

  console.log("\n=== RESUMEN ===");
  for (const item of summary) {
    const markersText = Object.entries(item.markers)
      .map(([key, value]) => `${key}:${value}`)
      .join(", ");
    console.log(
      `[${item.id}] ${item.title} | mensajes=${item.sent} | errores=${item.errors} | ${markersText}`,
    );
    if (item.violations.length) {
      for (const violation of item.violations) {
        console.log(
          `  ⚠️ [${item.id}.${violation.messageIndex || "?"}] ${violation.type}${
            violation.slot ? ` slot=${violation.slot}` : ""
          }`,
        );
      }
    }
  }

  const totalErrors = summary.reduce((acc, item) => acc + Number(item.errors || 0), 0);
  console.log(
    `\n=== AUDITORIA ===\nviolations=${allViolations.length} | sectionWithViolations=${
      summary.filter((item) => item.violations.length > 0).length
    } | totalErrors=${totalErrors}`,
  );

  if (options.reportFile) {
    const reportPath = path.resolve(options.reportFile);
    const lines = [];
    lines.push("# WhatsApp Defensive Replay Report");
    lines.push(`- GeneratedAt: ${new Date().toISOString()}`);
    lines.push(`- File: ${options.file}`);
    lines.push(`- Sections: ${summary.length}`);
    lines.push(`- Violations: ${allViolations.length}`);
    lines.push(`- TotalErrors: ${totalErrors}`);
    lines.push("");
    for (const item of summary) {
      lines.push(`## [${item.id}] ${item.title}`);
      lines.push(`- Sent: ${item.sent}`);
      lines.push(`- Errors: ${item.errors}`);
      lines.push(
        `- Markers: ${Object.entries(item.markers)
          .map(([k, v]) => `${k}:${v}`)
          .join(", ") || "none"}`,
      );
      if (!item.violations.length) {
        lines.push("- Violations: none");
      } else {
        lines.push("- Violations:");
        for (const violation of item.violations) {
          lines.push(
            `  - ${violation.type} @${item.id}.${violation.messageIndex || "?"}${
              violation.slot ? ` slot=${violation.slot}` : ""
            }`,
          );
        }
      }
      lines.push("");
    }
    fs.writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");
    console.log(`📝 Reporte guardado en: ${reportPath}`);
  }

  if (options.strictAssertions && (allViolations.length > 0 || totalErrors > 0)) {
    console.error(
      "❌ Replay finalizó con violaciones/errores y --strict-assertions está activo.",
    );
    process.exit(2);
  }
};

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Error ejecutando replay defensivo:", error);
    process.exit(1);
  });
