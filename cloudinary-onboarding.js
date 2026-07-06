require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const cloudinary = require("cloudinary").v2;

// Configure Cloudinary from environment variables (see backend/.env)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function main() {
  // 1. Upload a sample image from Cloudinary's public demo account
  const sampleImageUrl = "https://res.cloudinary.com/demo/image/upload/sample.jpg";
  const uploadResult = await cloudinary.uploader.upload(sampleImageUrl, {
    folder: "onboarding-test",
  });

  console.log("Uploaded image secure URL:", uploadResult.secure_url);
  console.log("Uploaded image public ID:", uploadResult.public_id);

  // 2. Get image details/metadata
  const details = await cloudinary.api.resource(uploadResult.public_id);
  console.log("Width:", details.width);
  console.log("Height:", details.height);
  console.log("Format:", details.format);
  console.log("Bytes:", details.bytes);

  // 3. Transform the image: f_auto picks the best format for the requesting
  // browser, q_auto picks the best quality/compression tradeoff automatically.
  const transformedUrl = cloudinary.url(uploadResult.public_id, {
    fetch_format: "auto",
    quality: "auto",
  });

  console.log("Done! Click link below to see optimized version of the image. Check the size and the format.");
  console.log(transformedUrl);
}

main().catch((err) => {
  console.error("Cloudinary onboarding script failed:", err);
  process.exit(1);
});
