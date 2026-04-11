// src/config/database.js
const mongoose = require('mongoose');
require('dotenv').config();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stateLabel = (state) => {
  switch (state) {
    case 0:
      return "disconnected";
    case 1:
      return "connected";
    case 2:
      return "connecting";
    case 3:
      return "disconnecting";
    default:
      return "unknown";
  }
};

const getConnectionOptions = () => ({
  serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 15000),
  socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45000),
  connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 15000),
  maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 10),
  minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 0),
  family: Number(process.env.MONGO_IP_FAMILY || 4),
});

let listenersAttached = false;
const attachConnectionListeners = () => {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on("connected", () => {
    console.log(`✅ MongoDB estado: ${stateLabel(mongoose.connection.readyState)}`);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn(`⚠️ MongoDB estado: ${stateLabel(mongoose.connection.readyState)}`);
  });

  mongoose.connection.on("reconnected", () => {
    console.log("✅ MongoDB reconectado.");
  });

  mongoose.connection.on("error", (error) => {
    console.error("❌ MongoDB error:", error?.message || error);
  });
};

const connectDB = async () => {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/padel-proactive';
  const maxAttempts = Number(process.env.MONGO_CONNECT_MAX_RETRIES || 12);

  attachConnectionListeners();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const conn = await mongoose.connect(uri, getConnectionOptions());
      console.log(`✅ MongoDB Conectado: ${conn.connection.host}`);
      return conn;
    } catch (error) {
      const delayMs = Math.min(30000, 1000 * 2 ** (attempt - 1));
      const isLast = attempt === maxAttempts;
      console.error(
        `❌ Error de conexión MongoDB (intento ${attempt}/${maxAttempts}): ${error?.message || error}`,
      );

      if (isLast) {
        throw error;
      }

      console.log(`↻ Reintentando conexión en ${Math.round(delayMs / 1000)}s...`);
      await sleep(delayMs);
    }
  }
};

const isMongoConnected = () => mongoose.connection.readyState === 1;

module.exports = connectDB;
module.exports.connectDB = connectDB;
module.exports.isMongoConnected = isMongoConnected;
