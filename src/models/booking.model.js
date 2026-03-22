const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    // 1. DÓNDE
    court: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Court",
      required: true,
    },
    // 2. CUÁNDO (Fecha calendario, SIN HORA)
    date: {
      type: Date,
      required: true,
      // Se guardará siempre como YYYY-MM-DDT00:00:00.000Z
    },
    // 3. QUÉ TURNO (Relación con el modelo de arriba)
    timeSlot: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TimeSlot",
      required: true,
    },
    // 4. QUIÉN
    clientName: { type: String, required: true },
    clientPhone: { type: String, required: true },

    // 5. ESTADO
    status: {
      type: String,
      enum: ["reservado", "confirmado", "cancelado", "suspendido"],
      default: "confirmado",
    },
    paymentStatus: {
      type: String,
      enum: ["pagado", "pendiente"],
      default: "pagado",
    },
    finalPrice: {
      // Por si hacemos un descuento manual sobre el precio del slot
      type: Number,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// La unicidad ahora se maneja 100% a nivel de aplicación (`createBooking`)

module.exports = mongoose.model("Booking", bookingSchema);
