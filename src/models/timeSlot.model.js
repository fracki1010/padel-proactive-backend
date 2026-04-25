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

module.exports = mongoose.model('TimeSlot', timeSlotSchema);
