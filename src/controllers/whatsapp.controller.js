const {
  getReadyClient,
  restartClient,
} = require("../services/whatsappTenantManager.service");

const resolveCompanyId = (req) => {
  if (req.user?.role === "super_admin") {
    return req.body?.companyId || null;
  }
  return req.user?.companyId || null;
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
    const client = getReadyClient(companyId);
    const sent = await client.sendMessage(chatId, String(message));

    console.log(
      `[WhatsApp][${companyId || "global"}] send OK to=${chatId} id=${sent?.id?._serialized || "n/a"}`,
    );

    return res.status(200).json({
      success: true,
      data: {
        companyId: companyId || null,
        to: chatId,
        messageId: sent?.id?._serialized || null,
      },
      error: null,
    });
  } catch (error) {
    const message = String(error?.message || "");
    const statusCode =
      message.includes("no está listo") ||
      message.includes("no está inicializado") ||
      message.includes("No existe cliente")
        ? 409
        : 500;

    console.error(
      `[WhatsApp][${resolveCompanyId(req) || "global"}] send ERROR:`,
      message || error,
    );

    return res.status(statusCode).json({
      success: false,
      data: null,
      error: message || "No se pudo enviar el mensaje por WhatsApp.",
    });
  }
};

const restartWhatsapp = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    await restartClient(companyId);

    return res.status(200).json({
      success: true,
      data: {
        companyId: companyId || null,
        restarted: true,
      },
      error: null,
    });
  } catch (error) {
    const message = String(error?.message || "");
    const statusCode = message.includes("arranque en curso") ? 409 : 500;

    console.error(
      `[WhatsApp][${resolveCompanyId(req) || "global"}] restart ERROR:`,
      message || error,
    );

    return res.status(statusCode).json({
      success: false,
      data: null,
      error: message || "No se pudo reiniciar el cliente de WhatsApp.",
    });
  }
};

module.exports = {
  sendMessage,
  restartWhatsapp,
};
