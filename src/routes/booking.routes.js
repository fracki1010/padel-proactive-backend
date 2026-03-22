const express = require("express");
const router = express.Router();
const {
  getBookings,
  createBooking,
  deleteBooking,
  updateBooking,
} = require("../controllers/booking.controller");

// GET http://localhost:3000/api/bookings -> Ver todas las reservas
router.get("/", getBookings);

// POST http://localhost:3000/api/bookings -> Crear una reserva
router.post("/", createBooking);

// PUT http://localhost:3000/api/bookings/:id -> Actualizar una reserva (ej: pago)
router.put("/:id", updateBooking);

// DELETE http://localhost:3000/api/bookings/:id -> Eliminar una reserva (o habilitar turno)
router.delete("/:id", deleteBooking);

module.exports = router;
