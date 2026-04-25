const { v2: cloudinary } = require("cloudinary");

const configured = Boolean(process.env.CLOUDINARY_URL || process.env.CLOUDINARY_CLOUD_NAME);

if (configured) {
  // CLOUDINARY_URL=cloudinary://api_key:api_secret@cloud_name   ← se auto-configura solo
  // O bien las tres vars separadas: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
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
