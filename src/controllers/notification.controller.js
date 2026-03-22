const Notification = require("../models/notification.model");
const { sendAdminNotification } = require("../services/notificationService");

// Obtener todas las notificaciones
const getNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find()
      .sort({ createdAt: -1 })
      .limit(50);
    res.status(200).json({ success: true, data: notifications });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Marcar como leída
const markAsRead = async (req, res) => {
  try {
    const notification = await Notification.findByIdAndUpdate(
      req.params.id,
      { isRead: true },
      { new: true },
    );
    res.status(200).json({ success: true, data: notification });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Marcar todas como leídas
const markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany({ isRead: false }, { isRead: true });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Enviar notificación de prueba (manual)
const sendTestAdminNotification = async (req, res) => {
  const { title, message, type } = req.body;

  try {
    await sendAdminNotification(
      type || "system",
      title || "Alerta Manual",
      message || "Esta es una notificación de prueba enviada desde el API.",
    );
    res
      .status(200)
      .json({ success: true, message: "Notificación enviada con éxito" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead,
  sendTestAdminNotification,
};
