const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('./cloudinary');

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'bohramarket',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'mp4'],
  },
});

module.exports = storage;