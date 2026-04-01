// src/models/Court.js
const mongoose = require('mongoose');

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
  surface: {
    type: String,
    default: 'Césped sintético' // Según business_info.txt
  },
  isIndoor: {
    type: Boolean,
    default: false // Según business_info.txt se suspende por lluvia, no es techado
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Court', courtSchema);
