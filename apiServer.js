require("dotenv").config();

const REQUIRED_ENV_VARS = ["MONGO_URI", "JWT_SECRET", "BACKEND_INTERNAL_TOKEN"];
const missingVars = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`❌ Variables de entorno requeridas faltantes: ${missingVars.join(", ")}`);
  process.exit(1);
}

const connectDB = require("./src/config/database");
const app = require("./src/app");
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
