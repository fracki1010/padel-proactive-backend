const { v2: cloudinary } = require("cloudinary");

// CLOUDINARY_URL=cloudinary://api_key:api_secret@cloud_name  → el SDK lo lee solo
// Si preferís las tres vars separadas: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

const configured = Boolean(process.env.CLOUDINARY_URL || process.env.CLOUDINARY_CLOUD_NAME);

if (configured) {
  console.log("✅ Cloudinary configurado.");
} else {
  console.warn("⚠️  Cloudinary no configurado — upload de imágenes deshabilitado.");
}

const uploadBuffer = (buffer, options = {}) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    stream.end(buffer);
  });

module.exports = { cloudinary, uploadBuffer, configured };
