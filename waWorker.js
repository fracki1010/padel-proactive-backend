require("dotenv").config();
const { connectDB } = require("./src/config/database");
const {
  syncAllWhatsappFromConfig,
} = require("./src/services/whatsappControl.service");
const {
  startWhatsappCommandMonitor,
} = require("./src/services/whatsappCommandQueue.service");
const {
  startAttendanceConfirmationMonitor,
} = require("./src/services/attendanceConfirmation.service");
const {
  startDailyAvailabilityDigestMonitor,
} = require("./src/services/dailyAvailabilityDigest.service");
const {
  DEFAULT_SERVICE_NAME,
  sendWorkerHeartbeat,
} = require("./src/services/workerHeartbeat.service");

const WORKER_HEARTBEAT_INTERVAL_MS = Number(
  process.env.WORKER_HEARTBEAT_INTERVAL_MS || 10_000,
);
const isRedisQueueDriver =
  String(process.env.WHATSAPP_QUEUE_DRIVER || "")
    .trim()
    .toLowerCase() === "redis";

let heartbeatTimer = null;

const startWorkerHeartbeat = () => {
  if (heartbeatTimer) return;

  const beat = () =>
    sendWorkerHeartbeat({ serviceName: DEFAULT_SERVICE_NAME }).catch((error) => {
      console.error(
        "[WorkerHeartbeat] Error enviando heartbeat:",
        error?.message || error,
      );
    });

  beat();
  heartbeatTimer = setInterval(beat, WORKER_HEARTBEAT_INTERVAL_MS);
};

connectDB()
  .then(async () => {
    startWorkerHeartbeat();
    console.log("✅ Heartbeat del worker iniciado.");

    if (!isRedisQueueDriver) {
      await syncAllWhatsappFromConfig();
      console.log("✅ Estado de WhatsApp sincronizado desde configuración.");
    } else {
      console.log(
        "ℹ️ WHATSAPP_QUEUE_DRIVER=redis: se omite inicialización local de WhatsApp en backend.",
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
    console.error("❌ Error inicializando worker WhatsApp:", err);
    process.exit(1);
  });
