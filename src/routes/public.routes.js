const express = require("express");
const router = express.Router({ mergeParams: true });
const {
  getClubInfo,
  getAvailability,
  sendOtp,
  registerClient,
  loginClient,
  googleAuth,
  getMe,
  updatePhone,
  createClientBooking,
  getMyBookings,
  cancelMyBooking,
} = require("../controllers/public.controller");
const { protectClient } = require("../middleware/clientAuth.middleware");
const { createRateLimiter } = require("../middleware/rateLimit.middleware");

// 3 OTPs por IP cada 15 minutos — evita spam de SMS
const otpRateLimit = createRateLimiter({ windowMs: 15 * 60_000, maxRequests: 3 });
// 10 intentos por IP cada 15 minutos para login/register/google
const authRateLimit = createRateLimiter({ windowMs: 15 * 60_000, maxRequests: 10 });

// Info del club (canchas + slots)
router.get("/", getClubInfo);

// Disponibilidad para una fecha
router.get("/availability", getAvailability);

// Auth de clientes
router.post("/auth/send-otp", otpRateLimit, sendOtp);
router.post("/auth/register", authRateLimit, registerClient);
router.post("/auth/login", authRateLimit, loginClient);
router.post("/auth/google", authRateLimit, googleAuth);
router.get("/auth/me", protectClient, getMe);
router.put("/auth/me/phone", protectClient, updatePhone);

// Reservas de clientes
router.post("/bookings", protectClient, createClientBooking);
router.get("/bookings", protectClient, getMyBookings);
router.delete("/bookings/:id", protectClient, cancelMyBooking);

module.exports = router;
