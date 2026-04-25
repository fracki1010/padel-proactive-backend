const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

let initialized = false;

const initFirebaseAdmin = () => {
  if (initialized) return;

  const bucket = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucket) {
    console.warn("⚠️  FIREBASE_STORAGE_BUCKET no configurado — upload a Storage deshabilitado.");
    return;
  }

  let serviceAccount;

  // Opción 1: archivo JSON en el proyecto
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    || path.join(__dirname, "../../../firebase-service-account.json");
  if (fs.existsSync(filePath)) {
    try {
      serviceAccount = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      console.error("❌ Error leyendo firebase-service-account.json:", err.message);
      return;
    }
  }

  // Opción 2: JSON en variable de entorno
  if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      console.error("❌ Error parseando FIREBASE_SERVICE_ACCOUNT_JSON:", err.message);
      return;
    }
  }

  if (!serviceAccount) {
    console.warn("⚠️  No se encontró credencial de Firebase Admin — upload a Storage deshabilitado.");
    return;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: bucket,
    });
    initialized = true;
    console.log("✅ Firebase Admin inicializado.");
  } catch (err) {
    console.error("❌ Error inicializando Firebase Admin:", err.message);
  }
};

const getStorageBucket = () => {
  if (!initialized) return null;
  return admin.storage().bucket();
};

module.exports = { initFirebaseAdmin, getStorageBucket };
