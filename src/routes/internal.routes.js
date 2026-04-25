const express = require("express");
const mongoose = require("mongoose");
const { handleIncomingMessage } = require("../handlers/messageHandler");
const { getGroqKeyPoolStats } = require("../services/groqService");
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

    if (!from || !body.trim()) {
      return res.status(400).json({
        success: false,
        error: "Campos 'from' y 'body' son obligatorios.",
      });
    }

    const responseRaw = await handleIncomingMessage(from, body, {
      companyId,
    });

    const messageToSend = extractReplyMessage(responseRaw).trim();

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
