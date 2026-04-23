const express = require("express");
const router = express.Router({ mergeParams: true });
const {
  getClubInfo,
  getAvailability,
  registerClient,
  loginClient,
  getMe,
  createClientBooking,
  getMyBookings,
  cancelMyBooking,
} = require("../controllers/public.controller");
const { protectClient } = require("../middleware/clientAuth.middleware");

// Información del club (canchas + slots)
router.get("/", getClubInfo);

// Disponibilidad para una fecha
router.get("/availability", getAvailability);

// Auth de clientes
router.post("/auth/register", registerClient);
router.post("/auth/login", loginClient);
router.get("/auth/me", protectClient, getMe);

// Reservas de clientes
router.post("/bookings", protectClient, createClientBooking);
router.get("/bookings", protectClient, getMyBookings);
router.delete("/bookings/:id", protectClient, cancelMyBooking);

module.exports = router;
