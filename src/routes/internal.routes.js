const express = require("express");
const mongoose = require("mongoose");
const { handleIncomingMessage } = require("../handlers/messageHandler");
const { handleIncomingReceipt } = require("../services/receiptVerification.service");
const { getGroqKeyPoolStats } = require("../services/groqService");
const { sanitizeOutgoingReply } = require("../utils/conversationGuardrails");
const {
  COMMAND_TYPES,
  enqueueWhatsappCommand,
} = require("../services/whatsappCommandQueue.service");

const router = express.Router();

const isInternalTokenValid = (req) => {
  const expectedToken = String(process.env.BACKEND_INTERNAL_TOKEN || "").trim();
  if (!expectedToken) return false;
  const receivedToken = String(req.headers["x-internal-token"] || "").trim();
  return receivedToken === expectedToken;
};

const normalizeCompanyId = (rawCompanyId) => {
  if (!rawCompanyId) return null;
  const value = String(rawCompanyId).trim();
  if (!value) return null;
  if (!mongoose.Types.ObjectId.isValid(value)) return null;
  return new mongoose.Types.ObjectId(value);
};

const extractReplyMessage = (responseRaw) => {
  if (typeof responseRaw === "object" && responseRaw?.message) {
    return String(responseRaw.message || "");
  }

  if (typeof responseRaw === "string") {
    const trimmed = responseRaw.trim();
    if (!trimmed) return "";

    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.message) return String(parsed.message || "");
      } catch {
        // noop
      }
    }

    return responseRaw;
  }

  return "";
};

router.post("/whatsapp/incoming", async (req, res) => {
  if (!isInternalTokenValid(req)) {
    return res.status(401).json({ success: false, error: "Invalid internal token" });
  }

  try {
    const from = String(req.body?.from || "").trim();
    const body = String(req.body?.body || "");
    const companyId = normalizeCompanyId(req.body?.companyId);
    const mediaRaw = req.body?.media;
    const hasMedia =
      Boolean(mediaRaw) &&
      typeof mediaRaw === "object" &&
      typeof mediaRaw.data === "string" &&
      mediaRaw.data.length > 0;

    if (!from || (!body.trim() && !hasMedia)) {
      return res.status(400).json({
        success: false,
        error: "Campos 'from' y 'body' son obligatorios.",
      });
    }

    // Media branch: a payment receipt (image/PDF) is verified by the bot and
    // auto-confirms a pending transfer seña. Best-effort by design — the
    // handler never throws into the webhook path.
    if (hasMedia) {
      const result = await handleIncomingReceipt({
        companyId,
        from,
        media: {
          mimetype: mediaRaw?.mimetype,
          filename: mediaRaw?.filename,
          buffer: Buffer.from(String(mediaRaw.data), "base64"),
        },
      });

      const mediaReply = sanitizeOutgoingReply(String(result?.reply || "").trim());
      if (!mediaReply) {
        return res.status(200).json({
          success: true,
          data: {
            handled: true,
            enqueued: false,
            confirmed: Boolean(result?.confirmed),
          },
        });
      }

      const { command } = await enqueueWhatsappCommand({
        companyId,
        type: COMMAND_TYPES.SEND_MESSAGE,
        payload: {
          to: from,
          message: mediaReply,
        },
        requestedBy: null,
      });

      return res.status(202).json({
        success: true,
        data: {
          handled: true,
          enqueued: true,
          confirmed: Boolean(result?.confirmed),
          commandId: command?._id ? String(command._id) : null,
        },
      });
    }

    const responseRaw = await handleIncomingMessage(from, body, {
      companyId,
    });

    // P0 (guarda de salida): cualquier reply que arranque como payload JSON crudo
    // (truncado/malformado que escapó del handler) se reemplaza por el nudge seguro.
    // Defensa en profundidad: nunca se encola JSON interno hacia WhatsApp.
    const messageToSend = sanitizeOutgoingReply(
      extractReplyMessage(responseRaw).trim(),
    );

    if (!messageToSend) {
      return res.status(200).json({
        success: true,
        data: {
          handled: true,
          enqueued: false,
        },
      });
    }

    const { command } = await enqueueWhatsappCommand({
      companyId,
      type: COMMAND_TYPES.SEND_MESSAGE,
      payload: {
        to: from,
        message: messageToSend,
      },
      requestedBy: null,
    });

    return res.status(202).json({
      success: true,
      data: {
        handled: true,
        enqueued: true,
        commandId: command?._id ? String(command._id) : null,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: String(error?.message || error),
    });
  }
});

router.get("/groq/key-pool", async (req, res) => {
  if (!isInternalTokenValid(req)) {
    return res.status(401).json({ success: false, error: "Invalid internal token" });
  }

  try {
    return res.status(200).json({
      success: true,
      data: getGroqKeyPoolStats(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: String(error?.message || error),
    });
  }
});

module.exports = router;
module.exports.extractReplyMessage = extractReplyMessage;
