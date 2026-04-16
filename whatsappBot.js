require("dotenv").config();
const { connectDB } = require("./src/config/database");
const app = require("./src/app");
const {
  syncAllWhatsappFromConfig,
} = require("./src/services/whatsappControl.service");
const {
  startAttendanceConfirmationMonitor,
} = require("./src/services/attendanceConfirmation.service");
const {
  startDailyAvailabilityDigestMonitor,
} = require("./src/services/dailyAvailabilityDigest.service");
const {
  startWhatsappCommandMonitor,
} = require("./src/services/whatsappCommandQueue.service");

const PORT = process.env.PORT || 3000;
const isRedisQueueDriver =
  String(process.env.WHATSAPP_QUEUE_DRIVER || "")
    .trim()
    .toLowerCase() === "redis";

// 1. Conexión a Base de Datos y Servidor Express
connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server corriendo en http://localhost:${PORT}`);
    });

    if (isRedisQueueDriver) {
      console.log(
        "ℹ️ WHATSAPP_QUEUE_DRIVER=redis: se omite inicialización local de WhatsApp en backend.",
      );
      return null;
    }

    return syncAllWhatsappFromConfig();
  })
  .then(() => {
    if (!isRedisQueueDriver) {
      console.log(
        "✅ Estado de WhatsApp sincronizado desde configuración (multiempresa).",
      );
    }
    startWhatsappCommandMonitor();
    console.log("✅ Monitor de comandos WhatsApp iniciado.");
    startAttendanceConfirmationMonitor();
    console.log("✅ Monitor de confirmación de asistencia iniciado.");
    startDailyAvailabilityDigestMonitor();
    console.log("✅ Monitor de disponibilidad diaria iniciado.");
  })
  .catch((err) => {
    console.error("❌ Error al conectar MongoDB:", err);
  });
console.log("🚀 Backend iniciado. WhatsApp gestionado por empresa.");
