const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('./cloudinary');
const { getCloudinaryTimestamp } = require('../utils/cloudinaryClock');

const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp'];

// Public storefront media (product, category, homepage images).
const makeStorage = (folder, allowedFormats = IMAGE_FORMATS) =>
  new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: `${process.env.CLOUDINARY_FOLDER || 'bohramarket'}/${folder}`,
      resource_type: 'image',
      allowed_formats: allowedFormats,
      timestamp: getCloudinaryTimestamp,
    },
  });

// Seller KYC documents (PAN, Aadhaar, bank proof). Uploaded as Cloudinary
// "private" assets: there is no public URL — the only way to view one is a
// short-lived signed download link the API issues to an admin or to the
// seller who owns it (see sellerController.getDocumentUrl).
const makePrivateDocumentStorage = (folder) =>
  new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: `${process.env.CLOUDINARY_FOLDER || 'bohramarket'}/${folder}`,
      resource_type: 'image', // PDFs are stored as Cloudinary image assets too
      type: 'private',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
      timestamp: getCloudinaryTimestamp,
    },
  });

module.exports = { makeStorage, makePrivateDocumentStorage, IMAGE_FORMATS };
