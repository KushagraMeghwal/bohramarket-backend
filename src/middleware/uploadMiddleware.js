const multer = require('multer');
const { makeStorage, makePrivateDocumentStorage } = require('../config/multerConfig');

const MB = 1024 * 1024;

// Size/count caps so a single request can't push arbitrarily large files
// through to Cloudinary.
const imageUpload = (folder, maxFiles = 6) =>
  multer({ storage: makeStorage(folder), limits: { fileSize: 5 * MB, files: maxFiles } });

const uploadSellerDocuments = multer({
  storage: makePrivateDocumentStorage('seller-documents'),
  limits: { fileSize: 10 * MB, files: 7 },
});
const uploadProductMedia = imageUpload('products', 6);
const uploadCategoryImage = imageUpload('categories', 1);
const uploadHomepageMedia = imageUpload('homepage', 1);
const uploadSiteContentMedia = imageUpload('site-content', 1);

module.exports = {
  uploadSellerDocuments,
  uploadProductMedia,
  uploadCategoryImage,
  uploadHomepageMedia,
  uploadSiteContentMedia,
};
