const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
    },
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
    clientWhatsappId: { type: String, default: null },
    canonicalClientId: { type: String, default: null },

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
    isFixed: {
      type: Boolean,
      default: false,
    },
    finalPrice: {
      // Por si hacemos un descuento manual sobre el precio del slot
      type: Number,
      required: true,
    },
    attendanceConfirmationStatus: {
      type: String,
      enum: ["pending", "confirmed", "declined", "not_required"],
      default: null,
    },
    attendanceConfirmationSentAt: {
      type: Date,
      default: null,
    },
    attendanceConfirmationRespondedAt: {
      type: Date,
      default: null,
    },
    attendanceNoResponseNotifiedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

bookingSchema.index(
  { companyId: 1, court: 1, date: 1, timeSlot: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $ne: "cancelado" } },
  },
);

bookingSchema.index({ companyId: 1, canonicalClientId: 1, date: 1 });

module.exports = mongoose.model("Booking", bookingSchema);
