const multer = require('multer');
const { makeStorage } = require('../config/multerConfig');

const uploadSellerDocuments = multer({ storage: makeStorage('seller-documents') });
const uploadProductMedia = multer({ storage: makeStorage('products') });
const uploadCategoryImage = multer({ storage: makeStorage('categories') });
const uploadHomepageMedia = multer({ storage: makeStorage('homepage') });
const uploadSiteContentMedia = multer({ storage: makeStorage('site-content') });

module.exports = {
  uploadSellerDocuments,
  uploadProductMedia,
  uploadCategoryImage,
  uploadHomepageMedia,
  uploadSiteContentMedia,
};
