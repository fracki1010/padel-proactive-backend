const Notification = require("../models/notification.model");
const Admin = require("../models/admin.model");
const {
  COMMAND_TYPES,
  enqueueWhatsappCommand,
} = require("./whatsappCommandQueue.service");
const {
  normalizeCanonicalClientPhone,
} = require("../utils/identityNormalization");

const normalizePhoneToChatId = (rawPhone = "") => {
  const digits = normalizeCanonicalClientPhone(rawPhone);
  if (!digits) return "";
  return `${digits}@c.us`;
};

const sendAdminNotification = async (
  type,
  title,
  message,
  data = {},
  options = {},
) => {
  try {
    const companyId = options.companyId || data.companyId || null;
    const queuedCommandIds = [];

    // 1. Guardar en Base de Datos (para la App)
    await Notification.create({
      companyId,
      type,
      title,
      message,
      data,
    });

    // 2. Enviar por WhatsApp a todos los Admins con teléfono
    const adminQuery = {
      phone: { $exists: true, $ne: "" },
      isActive: true,
    };
    if (companyId) {
      adminQuery.$or = [{ companyId }, { role: "super_admin" }];
    }
    const admins = await Admin.find(adminQuery);

    if (admins.length === 0) {
      console.warn(
        "[NotificationService] No se encontraron administradores con teléfono para notificar.",
      );
      return { queuedCommandIds, queuedCount: 0 };
    }

    // 2. Encolar envío por WhatsApp a todos los admins
    const phones = admins.map((a) => a.phone);
    const uniquePhones = [...new Set(phones)];
    const whatsappMessage = `🔔 *NUEVA NOTIFICACIÓN*\n\n*${title}*\n${message}`;

    for (const phone of uniquePhones) {
      const chatId = normalizePhoneToChatId(phone);
      if (!chatId) continue;

      try {
        const { command } = await enqueueWhatsappCommand({
          companyId,
          type: COMMAND_TYPES.SEND_MESSAGE,
          payload: {
            to: chatId,
            message: whatsappMessage,
          },
        });
        if (command?._id) {
          queuedCommandIds.push(String(command._id));
        }
      } catch (err) {
        console.error(
          `[NotificationService] Error encolando alerta para ${phone}:`,
          err?.message || err,
        );
      }
    }

    return {
      queuedCommandIds,
      queuedCount: queuedCommandIds.length,
    };
  } catch (error) {
    console.error("Error al enviar notificación:", error);
    throw error;
  }
};

module.exports = {
  sendAdminNotification,
};
