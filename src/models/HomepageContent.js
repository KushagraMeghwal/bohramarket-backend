const mongoose = require('mongoose');

const imageSchema = new mongoose.Schema(
  {
    url: String,
    publicId: String,
  },
  { _id: false }
);

const heroSlideSchema = new mongoose.Schema(
  {
    tag: { type: String, default: '' },
    title: { type: String, default: '' },
    subtitle: { type: String, default: '' },
    cta: { type: String, default: 'Shop Now' },
    ctaLink: { type: String, default: '/products' },
    image: { type: imageSchema, default: undefined },
  },
  { _id: false }
);

const trustPointSchema = new mongoose.Schema(
  {
    icon: { type: String, default: '' },
    title: { type: String, default: '' },
    sub: { type: String, default: '' },
  },
  { _id: false }
);

// Singleton document (there is only ever one) holding the editable parts of
// the storefront home page — hero carousel, trust strip, and the titles for
// the product rails — so admins can update copy/images without a deploy.
const homepageContentSchema = new mongoose.Schema(
  {
    heroSlides: { type: [heroSlideSchema], default: [] },
    trustPoints: { type: [trustPointSchema], default: [] },
    topRatedTitle: { type: String, default: 'Top Rated, Most Loved' },
    topRatedSubtitle: { type: String, default: 'Highest rated picks from sellers across every category' },
    bestForYouTitle: { type: String, default: 'Best For You' },
    bestForYouSubtitle: { type: String, default: 'Fresh picks curated across ridas, attars, topis and more' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('HomepageContent', homepageContentSchema);
