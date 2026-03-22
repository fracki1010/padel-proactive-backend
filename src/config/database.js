// src/config/database.js
const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
  try {
    // Asegúrate de tener MONGO_URI en tu archivo .env
    const conn = await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/padel-proactive');
    console.log(`✅ MongoDB Conectado: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ Error de conexión: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;