const mongoose = require('mongoose');

const timeSlotSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    default: null
  },
  startTime: {
    type: String,
    required: true, 
    trim: true // Ej: "20:00"
  },
  endTime: {
    type: String,
    required: true,
    trim: true // Ej: "21:30"
  },
  label: {
    type: String // Ej: "Turno Noche" (Opcional)
  },
  price: {
    type: Number,
    required: true // Precio base de este horario
  },
  // null => GENERAL slot: applies to every court that has no own slots.
  // A Court _id => the slot is OWNED by that court and overrides the general set.
  court: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Court",
    default: null
  },
  // Legacy slots may have no duration (null). New slots always store it and
  // derive `endTime` from it.
  durationMinutes: {
    type: Number,
    min: 15,
    max: 480,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number, // Para ordenarlos en el frontend (1, 2, 3...)
    required: true
  }
});

timeSlotSchema.index({ companyId: 1, isActive: 1 });
timeSlotSchema.index({ court: 1 });

module.exports = mongoose.model('TimeSlot', timeSlotSchema);
