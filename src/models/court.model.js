// src/models/Court.js
const mongoose = require('mongoose');

const COURT_TYPES = ["Estándar", "Techada", "Descubierta", "VIP", "Premium"];

const courtSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    default: null
  },
  name: {
    type: String,
    required: true,
    trim: true // Ej: "Cancha 1", "Central"
  },
  courtType: {
    type: String,
    enum: COURT_TYPES,
    default: "Estándar"
  },
  surface: {
    type: String,
    default: 'Césped sintético'
  },
  isIndoor: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

courtSchema.index({ companyId: 1, isActive: 1 });

module.exports = mongoose.model('Court', courtSchema);
module.exports.COURT_TYPES = COURT_TYPES;
