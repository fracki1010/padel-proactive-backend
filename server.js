// server.js (Actualizado)
require('dotenv').config();
const app = require('./src/app');
const connectDB = require('./src/config/database'); // Importar conexión

const PORT = process.env.PORT || 3000;

// 1. Conectar a Base de Datos
connectDB();

// 2. Iniciar Servidor
app.listen(PORT, () => {
  console.log(`--- Servidor corriendo ---`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`🤖 Modelo Groq listo para recibir mensajes`);
});