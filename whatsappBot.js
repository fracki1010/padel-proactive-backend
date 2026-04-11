require("dotenv").config();
const { connectDB } = require("./src/config/database");
const app = require("./src/app");
const {
  syncAllWhatsappFromConfig,
} = require("./src/services/whatsappControl.service");
const {
  startAttendanceConfirmationMonitor,
} = require("./src/services/attendanceConfirmation.service");

const PORT = process.env.PORT || 3000;

// 1. Conexión a Base de Datos y Servidor Express
connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server corriendo en http://localhost:${PORT}`);
    });

    return syncAllWhatsappFromConfig();
  })
  .then(() => {
    console.log(
      "✅ Estado de WhatsApp sincronizado desde configuración (multiempresa).",
    );
    startAttendanceConfirmationMonitor();
    console.log("✅ Monitor de confirmación de asistencia iniciado.");
  })
  .catch((err) => {
    console.error("❌ Error al conectar MongoDB:", err);
  });
console.log("🚀 Backend iniciado. WhatsApp gestionado por empresa.");
