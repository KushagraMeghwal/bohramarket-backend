const cloudinary = require('cloudinary').v2;

const REQUIRED_VARS = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const missingVars = REQUIRED_VARS.filter((key) => !process.env[key]);
if (missingVars.length) {
  // Cloudinary silently accepts undefined config and only fails later, deep
  // inside a request, with an opaque error — this makes a misconfigured
  // deployment fail loudly in the boot logs instead.
  console.error(`[cloudinary] Missing required env vars: ${missingVars.join(', ')} — all file uploads will fail.`);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

module.exports = cloudinary;