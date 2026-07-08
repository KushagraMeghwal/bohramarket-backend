const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('./cloudinary');
const { getCloudinaryTimestamp } = require('../utils/cloudinaryClock');

const makeStorage = (folder) =>
  new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: `bohramarket/${folder}`,
      resource_type: 'auto',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'pdf'],
      timestamp: getCloudinaryTimestamp,
    },
  });

module.exports = { makeStorage };
