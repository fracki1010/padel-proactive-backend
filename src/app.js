const express = require("express");
const cors = require("cors");
const chatRoutes = require("./routes/chatRoutes");
const bookingRoutes = require("./routes/booking.routes");
const authRoutes = require("./routes/auth.routes");
const { protect, requireRole } = require("./middleware/auth.middleware");
const superAdminRoutes = require("./routes/super-admin.routes");
const { createRateLimiter } = require("./middleware/rateLimit.middleware");

const app = express();

const normalizeOrigin = (value = "") => {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase();
  }
};

const isPrivateNetworkOrigin = (origin) =>
  /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)(?::\d+)?$/i.test(
    origin,
  );

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);
const chatRateLimit = createRateLimiter({
  windowMs: Number(process.env.CHAT_RATE_LIMIT_WINDOW_MS || 60_000),
  maxRequests: Number(process.env.CHAT_RATE_LIMIT_MAX || 30),
});

// Middlewares
app.use(
  cors({
    origin(origin, callback) {
      // Permitir herramientas sin origin (curl, postman, health checks)
      if (!origin) return callback(null, true);

      // Si no hay configuración explícita, permitir cualquier origin (útil en local)
      if (!allowedOrigins.length) return callback(null, true);

      const requestOrigin = normalizeOrigin(origin);
      if (allowedOrigins.includes(requestOrigin)) return callback(null, true);
      if (
        process.env.NODE_ENV !== "production" &&
        isPrivateNetworkOrigin(requestOrigin)
      ) {
        return callback(null, true);
      }

      return callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json());

// Rutas
app.use("/api/auth", authRoutes);
app.use("/api/chat", chatRateLimit, chatRoutes);
app.use("/api/bookings", protect, bookingRoutes);
app.use("/api/config", protect, require("./routes/config.routes"));
app.use("/api/whatsapp", protect, require("./routes/whatsapp.routes"));
app.use("/api/users", protect, require("./routes/user.routes"));
app.use("/api/notifications", protect, require("./routes/notification.routes"));
app.use(
  "/api/super-admin",
  protect,
  requireRole("super_admin"),
  superAdminRoutes,
);

// Ruta básica de prueba
app.get("/", (req, res) => {
  res.send("¡El servidor del Chatbot Groq y Reservas está funcionando! 🚀");
});

module.exports = app;
