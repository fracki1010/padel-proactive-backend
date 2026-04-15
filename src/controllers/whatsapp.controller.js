const mongoose = require("mongoose");
const WhatsappCommand = require("../models/whatsappCommand.model");
const {
  COMMAND_TYPES,
  enqueueWhatsappCommand,
} = require("../services/whatsappCommandQueue.service");

const resolveCompanyId = (req) => {
  if (req.user?.role === "super_admin") {
    return req.query?.companyId || req.body?.companyId || null;
  }
  return req.user?.companyId || null;
};

const listCommands = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const isSuperAdmin = req.user?.role === "super_admin";
    const limitRaw = Number(req.query?.limit || 20);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));
    const statusFilter = String(req.query?.status || "").trim().toLowerCase();
    const typeFilter = String(req.query?.type || "").trim().toLowerCase();

    const filter = {};
    if (isSuperAdmin) {
      if (companyId) {
        filter.companyId = companyId;
      }
    } else {
      filter.companyId = companyId || null;
    }
    if (statusFilter) {
      filter.status = statusFilter;
    }
    if (typeFilter) {
      filter.type = typeFilter;
    }

    const commands = await WhatsappCommand.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      data: commands.map((command) => ({
        id: String(command._id),
        companyId: command.companyId ? String(command.companyId) : null,
        type: String(command.type || ""),
        status: String(command.status || "unknown"),
        attempts: Number(command.attempts || 0),
        maxAttempts: Number(command.maxAttempts || 0),
        lastError: command.lastError ? String(command.lastError) : null,
        createdAt: command.createdAt || null,
        updatedAt: command.updatedAt || null,
        processedAt: command.processedAt || null,
      })),
      error: null,
    });
  } catch (error) {
    const message = String(error?.message || "");
    return res.status(500).json({
      success: false,
      data: null,
      error: message || "No se pudo listar comandos de WhatsApp.",
    });
  }
};

const retryCommand = async (req, res) => {
  try {
    const commandId = String(req.params?.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(commandId)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: "commandId inválido.",
      });
    }

    const command = await WhatsappCommand.findById(commandId).lean();
    if (!command) {
      return res.status(404).json({
        success: false,
        data: null,
        error: "Comando no encontrado.",
      });
    }

    const requesterCompanyId = resolveCompanyId(req);
    const commandCompanyId = command.companyId ? String(command.companyId) : null;
    const isSuperAdmin = req.user?.role === "super_admin";
    if (!isSuperAdmin && String(requesterCompanyId || "") !== String(commandCompanyId || "")) {
      return res.status(403).json({
        success: false,
        data: null,
        error: "No tenés permisos para reintentar este comando.",
      });
    }

    const normalizedType = String(command.type || "").trim();
    const supportedTypes = new Set([
      COMMAND_TYPES.SET_ENABLED,
      COMMAND_TYPES.SEND_MESSAGE,
      COMMAND_TYPES.RESTART_CLIENT,
      COMMAND_TYPES.LIST_GROUPS,
      COMMAND_TYPES.NOTIFY_CANCELLATION_GROUP,
    ]);
    if (!supportedTypes.has(normalizedType)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: "Este tipo de comando no soporta reintento.",
      });
    }

    if (String(command.status || "").toLowerCase() !== "failed") {
      return res.status(400).json({
        success: false,
        data: null,
        error: "Solo se pueden reintentar comandos en estado failed.",
      });
    }

    const { command: retried } = await enqueueWhatsappCommand({
      companyId: command.companyId || null,
      type: normalizedType,
      payload:
        command.payload && typeof command.payload === "object"
          ? command.payload
          : {},
      requestedBy: req.user?._id || null,
    });

    return res.status(202).json({
      success: true,
      data: {
        commandId: retried?._id ? String(retried._id) : null,
        status: "queued",
      },
      error: null,
    });
  } catch (error) {
    const message = String(error?.message || "");
    return res.status(500).json({
      success: false,
      data: null,
      error: message || "No se pudo reintentar el comando.",
    });
  }
};

const getCommandStatus = async (req, res) => {
  try {
    const commandId = String(req.params?.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(commandId)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: "commandId inválido.",
      });
    }

    const command = await WhatsappCommand.findById(commandId).lean();
    if (!command) {
      return res.status(404).json({
        success: false,
        data: null,
        error: "Comando no encontrado.",
      });
    }

    const requesterCompanyId = resolveCompanyId(req);
    const commandCompanyId = command.companyId ? String(command.companyId) : null;
    const isSuperAdmin = req.user?.role === "super_admin";

    if (!isSuperAdmin && String(requesterCompanyId || "") !== String(commandCompanyId || "")) {
      return res.status(403).json({
        success: false,
        data: null,
        error: "No tenés permisos para consultar este comando.",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: String(command._id),
        type: String(command.type || ""),
        status: String(command.status || "unknown"),
        attempts: Number(command.attempts || 0),
        maxAttempts: Number(command.maxAttempts || 0),
        lastError: command.lastError ? String(command.lastError) : null,
        createdAt: command.createdAt || null,
        updatedAt: command.updatedAt || null,
        processedAt: command.processedAt || null,
      },
      error: null,
    });
  } catch (error) {
    const message = String(error?.message || "");
    return res.status(500).json({
      success: false,
      data: null,
      error: message || "No se pudo consultar el estado del comando.",
    });
  }
};

const normalizePhone = (rawPhone = "") => String(rawPhone).replace(/\D/g, "");

const sendMessage = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const { to, message } = req.body || {};

    if (!to || !message || !String(message).trim()) {
      return res.status(400).json({
        success: false,
        data: null,
        error: "Los campos 'to' y 'message' son obligatorios.",
      });
    }

    const normalizedTo = normalizePhone(to);
    if (!normalizedTo) {
      return res.status(400).json({
        success: false,
        data: null,
        error: "El campo 'to' no contiene un número válido.",
      });
    }

    const chatId = `${normalizedTo}@c.us`;
    const { command } = await enqueueWhatsappCommand({
      companyId,
      type: COMMAND_TYPES.SEND_MESSAGE,
      payload: {
        to: chatId,
        message: String(message),
      },
      requestedBy: req.user?._id || null,
    });

    console.log(
      `[WhatsApp][${companyId || "global"}] send queued to=${chatId} command=${command?._id || "n/a"}`,
    );

    return res.status(202).json({
      success: true,
      data: {
        companyId: companyId || null,
        to: chatId,
        commandId: command?._id || null,
        status: "queued",
      },
      error: null,
    });
  } catch (error) {
    const message = String(error?.message || "");

    console.error(
      `[WhatsApp][${resolveCompanyId(req) || "global"}] send ERROR:`,
      message || error,
    );

    return res.status(500).json({
      success: false,
      data: null,
      error: message || "No se pudo enviar el mensaje por WhatsApp.",
    });
  }
};

const restartWhatsapp = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const { command } = await enqueueWhatsappCommand({
      companyId,
      type: COMMAND_TYPES.RESTART_CLIENT,
      payload: {},
      requestedBy: req.user?._id || null,
    });

    return res.status(202).json({
      success: true,
      data: {
        companyId: companyId || null,
        commandId: command?._id || null,
        status: "queued",
      },
      error: null,
    });
  } catch (error) {
    const message = String(error?.message || "");

    console.error(
      `[WhatsApp][${resolveCompanyId(req) || "global"}] restart ERROR:`,
      message || error,
    );

    return res.status(500).json({
      success: false,
      data: null,
      error: message || "No se pudo reiniciar el cliente de WhatsApp.",
    });
  }
};

module.exports = {
  listCommands,
  getCommandStatus,
  retryCommand,
  sendMessage,
  restartWhatsapp,
};
