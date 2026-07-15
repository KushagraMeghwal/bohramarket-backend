const HomepageContent = require('../models/HomepageContent');
const asyncHandler = require('../utils/asyncHandler');

// Seed values — used the first time this collection is read, before any
// admin has saved a customization. Mirrors what used to be hardcoded in the
// frontend so the storefront looks identical on day one.
const DEFAULT_CONTENT = {
  heroSlides: [
    {
      tag: 'Golden Hour Sale',
      title: 'Boutique heritage pieces, modern .',
      subtitle: 'From ridas and topis to attars, gifting sellers present their finest work beautifully.',
      cta: 'Shop the Sale',
      ctaLink: '/products',
    },
    {
      tag: 'Zero Listing Fees',
      title: 'Turn your craft into a thriving storefront.',
      subtitle: 'List anything in minutes. No fees this week, and easy onboarding for community-verified sellers.',
      cta: 'Start Selling',
      ctaLink: '/seller/apply',
    },
    {
      tag: 'Verified Sellers',
      title: 'Every order, quality checked.',
      subtitle: 'Community-verified vendors, honest reviews and easy returns — shop with confidence.',
      cta: 'Explore Categories',
      ctaLink: '/products',
    },
  ],
  trustPoints: [
    { icon: '🚚', title: 'Free Shipping', sub: 'On orders above Rs 999' },
    { icon: '🛡️', title: 'Buyer Protection', sub: 'Verified sellers only' },
    { icon: '↩️', title: 'Easy Returns', sub: '7-day return window' },
    { icon: '💬', title: '24/7 Support', sub: '' },
  ],
  topRatedTitle: 'Top Rated, Most Loved',
  topRatedSubtitle: 'Highest rated picks from sellers across every category',
  bestForYouTitle: 'Best For You',
  bestForYouSubtitle: 'Fresh picks curated across ridas, attars, topis and more',
};

const getOrCreateSingleton = async () => {
  let content = await HomepageContent.findOne();
  if (!content) {
    content = await HomepageContent.create(DEFAULT_CONTENT);
  }
  return content;
};

// GET /api/homepage
const getHomepageContent = asyncHandler(async (req, res) => {
  const content = await getOrCreateSingleton();
  res.json({ content });
});

// PUT /api/homepage (admin only)
const updateHomepageContent = asyncHandler(async (req, res) => {
  const { heroSlides, trustPoints, topRatedTitle, topRatedSubtitle, bestForYouTitle, bestForYouSubtitle } = req.body;

  const content = await getOrCreateSingleton();

  if (heroSlides !== undefined) content.heroSlides = heroSlides;
  if (trustPoints !== undefined) content.trustPoints = trustPoints;
  if (topRatedTitle !== undefined) content.topRatedTitle = topRatedTitle;
  if (topRatedSubtitle !== undefined) content.topRatedSubtitle = topRatedSubtitle;
  if (bestForYouTitle !== undefined) content.bestForYouTitle = bestForYouTitle;
  if (bestForYouSubtitle !== undefined) content.bestForYouSubtitle = bestForYouSubtitle;
  content.updatedBy = req.user._id;

  await content.save();
  res.json({ content });
});

// POST /api/homepage/upload-image (admin only) — uploads a single hero slide
// image and hands back its URL, so the editor can attach it to a slide
// before the surrounding PUT /api/homepage save.
const uploadHomepageImage = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }

  res.json({ image: { url: req.file.path, publicId: req.file.filename } });
});

module.exports = { getHomepageContent, updateHomepageContent, uploadHomepageImage };
