const mongoose = require("mongoose");

// Deposit (seña) subdocument. A booking with deposits enabled is created as
// `pendiente_seña` and stores the seña amount, status and MercadoPago linkage.
// The court is held by the existing non-cancelled unique index while pending.
const depositSchema = new mongoose.Schema(
  {
    required: { type: Boolean, default: false },
    amount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pendiente", "pagado", "expirado", "refund_pending", "reembolsado"],
      default: null,
    },
    preferenceId: { type: String, default: null },
    paymentId: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    refundable: { type: Boolean, default: false },
  },
  { _id: false },
);

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
      enum: [
        "reservado",
        "confirmado",
        "cancelado",
        "suspendido",
        "pendiente_seña",
      ],
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
    deposit: {
      type: depositSchema,
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

// Expiry sweeper: unpaid deposits whose deadline has passed, scoped per company.
bookingSchema.index({ companyId: 1, "deposit.status": 1, "deposit.expiresAt": 1 });

// Global sweep (NEW-2): the sweeper scans EVERY pending hold across companies
// regardless of the current depositEnabled flag, so its filter has no leading
// companyId — it needs a status-led index to avoid a collection scan.
bookingSchema.index({ status: 1, "deposit.status": 1, "deposit.expiresAt": 1 });

// A MercadoPago payment may be linked to at most one booking. Partial (not
// sparse) so the many bookings without a paymentId are excluded even though the
// subdocument exists with `paymentId: null`.
bookingSchema.index(
  { "deposit.paymentId": 1 },
  {
    unique: true,
    partialFilterExpression: { "deposit.paymentId": { $type: "string" } },
  },
);

module.exports = mongoose.model("Booking", bookingSchema);
