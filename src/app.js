const express = require("express");
const cors = require("cors");
const chatRoutes = require("./routes/chatRoutes");
const bookingRoutes = require("./routes/booking.routes");
const authRoutes = require("./routes/auth.routes");
const { protect } = require("./middleware/auth.middleware");

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Middlewares
app.use(
  cors({
    origin(origin, callback) {
      // Permitir herramientas sin origin (curl, postman, health checks)
      if (!origin) return callback(null, true);

      // Si no hay configuración explícita, permitir cualquier origin (útil en local)
      if (!allowedOrigins.length) return callback(null, true);

      if (allowedOrigins.includes(origin)) return callback(null, true);

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json());

// Rutas
app.use("/api/auth", authRoutes);
app.use("/api/chat", chatRoutes); // El chat puede necesitar ser público si el bot consulta algo, pero el bot usa handlers directamente.
app.use("/api/bookings", protect, bookingRoutes);
app.use("/api/config", protect, require("./routes/config.routes"));
app.use("/api/users", protect, require("./routes/user.routes"));
app.use("/api/notifications", protect, require("./routes/notification.routes"));

// Ruta básica de prueba
app.get("/", (req, res) => {
  res.send("¡El servidor del Chatbot Groq y Reservas está funcionando! 🚀");
});

module.exports = app;
