const Notification = require("../models/notification.model");
const Admin = require("../models/admin.model");
const client = require("../config/whatsappClient");
const { getWhatsappState } = require("../state/whatsapp.state");

const sendAdminNotification = async (type, title, message, data = {}) => {
  console.log("comienza a enviar mensaje");

  try {
    // 1. Guardar en Base de Datos (para la App)
    await Notification.create({
      type,
      title,
      message,
      data,
    });

    // 2. Enviar por WhatsApp a todos los Admins con teléfono
    const admins = await Admin.find({ phone: { $exists: true, $ne: "" } });

    if (admins.length === 0) {
      console.warn(
        "[NotificationService] No se encontraron administradores con teléfono para notificar.",
      );
      return;
    }

    if (!getWhatsappState().enabled) {
      console.log("[NotificationService] WhatsApp desactivado. Solo se guarda en la app.");
      return;
    }

    if (!client || !client.isReady) {
      console.warn(
        "[NotificationService] El cliente de WhatsApp no está listo para enviar mensajes.",
      );
      return;
    }

    // Lista de números a notificar
    const phones = admins.map((a) => a.phone);

    console.log(phones);

    // Eliminar duplicados y formatear
    const uniquePhones = [...new Set(phones)];

    for (const phone of uniquePhones) {
      console.log(phone);
      try {
        // 3. Validar y obtener el ID correcto de WhatsApp
        const numberId = await client.getNumberId(phone);

        if (!numberId) {
          console.warn(
            `[NotificationService] El número ${phone} no está registrado en WhatsApp.`,
          );
          continue;
        }

        const whatsappMessage = `🔔 *NUEVA NOTIFICACIÓN*\n\n*${title}*\n${message}`;

        console.log(
          `[NotificationService] Enviando alerta a ${numberId._serialized}...`,
        );
        await client.sendMessage(numberId._serialized, whatsappMessage);
      } catch (err) {
        console.error(
          `[NotificationService] Error al enviar a ${phone}:`,
          err.message,
        );
      }
    }
  } catch (error) {
    console.error("Error al enviar notificación:", error);
  }
};

module.exports = {
  sendAdminNotification,
};
