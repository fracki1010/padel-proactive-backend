const express = require("express");
const router = express.Router({ mergeParams: true });
const {
  getClubInfo,
  getAvailability,
  getAnnouncements,
  acquireSlotLockHandler,
  releaseSlotLockHandler,
  sendOtp,
  verifyOtp,
  completeRegistration,
  googleAuth,
  getMe,
  updatePhone,
  createClientBooking,
  getMyBookings,
  cancelMyBooking,
  createPaymentLink,
} = require("../controllers/public.controller");
const { protectClient } = require("../middleware/clientAuth.middleware");
const { createRateLimiter } = require("../middleware/rateLimit.middleware");

// 3 OTPs por IP cada 15 minutos — evita spam de SMS
const otpRateLimit = createRateLimiter({ windowMs: 15 * 60_000, maxRequests: 3 });
// 10 intentos por IP cada 15 minutos para login/register/google
const authRateLimit = createRateLimiter({ windowMs: 15 * 60_000, maxRequests: 10 });
// 40 locks por IP cada 15 minutos — evita abuso del slot lock
const slotLockRateLimit = createRateLimiter({ windowMs: 15 * 60_000, maxRequests: 40 });
// 20 links de pago por IP cada 15 minutos — evita mint/abuso de preferencias
const PAYMENT_LINK_RATE_LIMIT_WINDOW_MS = Number(
  process.env.PAYMENT_LINK_RATE_LIMIT_WINDOW_MS || 15 * 60_000,
);
const PAYMENT_LINK_RATE_LIMIT_MAX = Number(
  process.env.PAYMENT_LINK_RATE_LIMIT_MAX || 20,
);
const paymentLinkRateLimiter = createRateLimiter({
  windowMs: PAYMENT_LINK_RATE_LIMIT_WINDOW_MS,
  maxRequests: PAYMENT_LINK_RATE_LIMIT_MAX,
});

// Info del club (canchas + slots)
router.get("/", getClubInfo);

// Disponibilidad para una fecha
router.get("/availability", getAvailability);

// Bloqueo temporal de un turno mientras el cliente completa la reserva
router.post("/slot-lock", slotLockRateLimit, acquireSlotLockHandler);
router.delete("/slot-lock/:id", slotLockRateLimit, releaseSlotLockHandler);

// Avisos vigentes del club (público)
router.get("/announcements", getAnnouncements);

// Auth de clientes (WhatsApp + OTP)
router.post("/auth/send-otp", otpRateLimit, sendOtp);
router.post("/auth/verify-otp", authRateLimit, verifyOtp);
router.post("/auth/complete-registration", authRateLimit, completeRegistration);
router.post("/auth/google", authRateLimit, googleAuth);
router.get("/auth/me", protectClient, getMe);
router.put("/auth/me/phone", protectClient, updatePhone);

// Reservas de clientes
router.post("/bookings", protectClient, createClientBooking);
router.get("/bookings", protectClient, getMyBookings);
router.post("/bookings/:id/payment-link", paymentLinkRateLimiter, protectClient, createPaymentLink);
router.delete("/bookings/:id", protectClient, cancelMyBooking);

module.exports = router;
module.exports.paymentLinkRateLimiter = paymentLinkRateLimiter;
module.exports.PAYMENT_LINK_RATE_LIMIT_MAX = PAYMENT_LINK_RATE_LIMIT_MAX;
module.exports.PAYMENT_LINK_RATE_LIMIT_WINDOW_MS = PAYMENT_LINK_RATE_LIMIT_WINDOW_MS;
