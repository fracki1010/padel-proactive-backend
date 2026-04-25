require("dotenv").config();
const connectDB = require("./src/config/database");
const { initFirebaseAdmin } = require("./src/lib/firebaseAdmin");
const app = require("./src/app");

initFirebaseAdmin();
const {
  startAttendanceConfirmationMonitor,
} = require("./src/services/attendanceConfirmation.service");

const PORT = process.env.PORT || 3000;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 API corriendo en http://localhost:${PORT}`);
    });
    startAttendanceConfirmationMonitor();
    console.log("✅ Monitor de confirmación de asistencia iniciado.");
    if (
      String(process.env.ATTENDANCE_DEBUG || "")
        .trim()
        .toLowerCase() === "true"
    ) {
      console.log("🧪 ATTENDANCE_DEBUG=true (logs detallados habilitados)");
    }
  })
  .catch((err) => {
    console.error("❌ Error al conectar MongoDB:", err);
    process.exit(1);
  });
