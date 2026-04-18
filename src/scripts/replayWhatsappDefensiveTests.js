#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../config/database");
const sessionService = require("../services/sessionService");
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
    companyId: process.env.WA_TEST_COMPANY_ID || null,
    chatBase: process.env.WA_TEST_CHAT_BASE || "qa-defensive",
    sameSession: false,
    section: null,
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
    if (arg === "--same-session") {
      options.sameSession = true;
      continue;
    }
  }

  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    options.delayMs = 250;
  }

  return options;
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
  const sections = options.section
    ? allSections.filter((item) => String(item.id) === String(options.section))
    : allSections;

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

  await connectDB();

  const summary = [];
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
      };

      for (let i = 0; i < section.messages.length; i += 1) {
        const userMessage = String(section.messages[i] || "");
        if (!userMessage.trim()) continue;

        sectionResult.sent += 1;
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
        process.stdout.write(`⬅️  [${section.id}.${i + 1}] BOT: ${replyText}\n`);

        if (options.delayMs > 0) {
          await sleep(options.delayMs);
        }
      }

      summary.push(sectionResult);
      sessionService.clearHistory(sessionId);
    }
  } finally {
    if (mongoose?.connection?.close) {
      await mongoose.connection.close();
    }
  }

  console.log("\n=== RESUMEN ===");
  for (const item of summary) {
    const markersText = Object.entries(item.markers)
      .map(([key, value]) => `${key}:${value}`)
      .join(", ");
    console.log(
      `[${item.id}] ${item.title} | mensajes=${item.sent} | errores=${item.errors} | ${markersText}`,
    );
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
