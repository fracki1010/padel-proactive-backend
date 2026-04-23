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

// Info del club (canchas + slots)
router.get("/", getClubInfo);

// Disponibilidad para una fecha
router.get("/availability", getAvailability);

// Auth de clientes
router.post("/auth/send-otp", sendOtp);
router.post("/auth/register", registerClient);
router.post("/auth/login", loginClient);
router.post("/auth/google", googleAuth);
router.get("/auth/me", protectClient, getMe);
router.put("/auth/me/phone", protectClient, updatePhone);

// Reservas de clientes
router.post("/bookings", protectClient, createClientBooking);
router.get("/bookings", protectClient, getMyBookings);
router.delete("/bookings/:id", protectClient, cancelMyBooking);

module.exports = router;
