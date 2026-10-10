const express = require("express");
const router = express.Router();
const {
  getBookings,
  createBooking,
  deleteBooking,
  updateBooking,
  confirmDepositReceived,
  rematerializeFixedTurns,
} = require("../controllers/booking.controller");
const { requireRole } = require("../middleware/auth.middleware");

// GET http://localhost:3000/api/bookings -> Ver todas las reservas
router.get("/", getBookings);

// POST http://localhost:3000/api/bookings -> Crear una reserva
router.post("/", createBooking);

// POST http://localhost:3000/api/bookings/fixed-turns/rematerialize
router.post(
  "/fixed-turns/rematerialize",
  requireRole("admin", "super_admin"),
  rematerializeFixedTurns,
);

// POST http://localhost:3000/api/bookings/:id/deposit-received
// Confirma manualmente una seña recibida por transferencia (admin).
router.post(
  "/:id/deposit-received",
  requireRole("admin", "super_admin"),
  confirmDepositReceived,
);

// PUT http://localhost:3000/api/bookings/:id -> Actualizar una reserva (ej: pago)
router.put("/:id", updateBooking);

// DELETE http://localhost:3000/api/bookings/:id -> Eliminar una reserva (o habilitar turno)
router.delete("/:id", deleteBooking);

module.exports = router;
