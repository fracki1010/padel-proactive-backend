require('dotenv').config(); // Cargar variables de entorno
const Groq = require('groq-sdk');

const parseGroqApiKey = () => {
  const multi = String(process.env.GROQ_API_KEYS || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

  if (multi.length > 0) return multi[0];

  const single = String(process.env.GROQ_API_KEY || "").trim();
  return single || null;
};

const apiKey = parseGroqApiKey();

// Verificamos que exista al menos una API KEY para evitar errores silenciosos
if (!apiKey) {
  console.error("ERROR: No se encontró GROQ_API_KEY ni GROQ_API_KEYS en el archivo .env");
  process.exit(1);
}

// Inicializamos el cliente
const groq = new Groq({
  apiKey
});

module.exports = groq;
