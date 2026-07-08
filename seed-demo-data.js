// One-off seed script for local development: creates a handful of categories,
// an approved demo seller, and active demo products so the storefront has
// real content to browse. Uses Cloudinary's public demo images as generic
// placeholders — replace via the real seller product-upload flow later.
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./src/models/User');
const Seller = require('./src/models/Seller');
const Category = require('./src/models/Category');
const Product = require('./src/models/Product');

const DEMO_IMAGES = [
  'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  'https://res.cloudinary.com/demo/image/upload/shoes.jpg',
  'https://res.cloudinary.com/demo/image/upload/balloons.jpg',
  'https://res.cloudinary.com/demo/image/upload/bike.jpg',
];

const mediaFrom = (url, i) => ({ url, publicId: `seed/placeholder-${i}` });

const CATEGORIES = [
  { name: 'Ridas', slug: 'ridas' },
  { name: 'Topis', slug: 'topis' },
  { name: 'Attars', slug: 'attars' },
  { name: 'Jewelry', slug: 'jewelry' },
  { name: 'Home Decor', slug: 'home-decor' },
  { name: 'Handicrafts', slug: 'handicrafts' },
];

const PRODUCTS = [
  {
    name: 'Emerald Silk Rida (S)',
    category: 'ridas',
    price: 4500,
    discountPrice: 3999,
    stock: 12,
    variantGroupId: 'rida-emerald-silk',
    attributes: { size: 'S', color: 'Emerald' },
  },
  {
    name: 'Emerald Silk Rida (M)',
    category: 'ridas',
    price: 4500,
    discountPrice: 3999,
    stock: 9,
    variantGroupId: 'rida-emerald-silk',
    attributes: { size: 'M', color: 'Emerald' },
  },
  {
    name: 'Emerald Silk Rida (L)',
    category: 'ridas',
    price: 4700,
    stock: 7,
    variantGroupId: 'rida-emerald-silk',
    attributes: { size: 'L', color: 'Emerald' },
  },
  { name: 'Gold-Embroidered Rida', category: 'ridas', price: 6200, stock: 8 },
  { name: 'Classic White Topi', category: 'topis', price: 350, stock: 40 },
  { name: 'Zari-Work Topi', category: 'topis', price: 550, discountPrice: 450, stock: 25 },
  { name: 'Oudh Al Sharq Attar', category: 'attars', price: 1200, stock: 30 },
  { name: 'Rose Musk Attar', category: 'attars', price: 950, stock: 18 },
  { name: 'Kundan Necklace Set', category: 'jewelry', price: 3200, discountPrice: 2799, stock: 6 },
  { name: 'Silver Oxidised Jhumkas', category: 'jewelry', price: 890, stock: 22 },
  { name: 'Hand-Carved Wooden Tray', category: 'home-decor', price: 1450, stock: 10 },
  { name: 'Brass Table Lantern', category: 'home-decor', price: 1750, discountPrice: 1499, stock: 14 },
  { name: 'Woven Palm Basket', category: 'handicrafts', price: 620, stock: 20 },
  { name: 'Hand-Painted Ceramic Vase', category: 'handicrafts', price: 1100, stock: 9 },
];

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const categoryDocs = {};
  for (const c of CATEGORIES) {
    categoryDocs[c.slug] = await Category.findOneAndUpdate(
      { slug: c.slug },
      { name: c.name, slug: c.slug },
      { upsert: true, returnDocument: 'after' }
    );
  }
  console.log(`Categories ready: ${Object.keys(categoryDocs).length}`);

  const demoEmail = 'demo.seller@bohramart.com';
  let user = await User.findOne({ email: demoEmail });
  if (!user) {
    user = await User.create({
      name: 'BohraMart Demo Seller',
      email: demoEmail,
      password: 'password123',
      role: 'seller',
    });
  }

  let seller = await Seller.findOne({ user: user._id });
  if (!seller) {
    seller = await Seller.create({
      user: user._id,
      businessName: 'BohraMart Curated Collection',
      contactPhone: '9000000000',
      pickupAddress: { line1: 'Demo Warehouse', city: 'Surat', state: 'Gujarat', pincode: '395001' },
      status: 'approved',
    });
  } else if (seller.status !== 'approved') {
    seller.status = 'approved';
    await seller.save();
  }
  console.log(`Demo seller ready: ${seller._id}`);

  let created = 0;
  for (const [i, p] of PRODUCTS.entries()) {
    const existing = await Product.findOne({ name: p.name, seller: seller._id });
    if (existing) continue;

    const image = DEMO_IMAGES[i % DEMO_IMAGES.length];
    await Product.create({
      seller: seller._id,
      name: p.name,
      slug: `${p.name}-${Date.now()}-${i}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      description: `${p.name} — a handpicked piece from ${categoryDocs[p.category].name}. Demo seed data; replace with real inventory.`,
      category: categoryDocs[p.category]._id,
      images: [mediaFrom(image, i)],
      price: p.price,
      discountPrice: p.discountPrice,
      sku: `SEED-${p.category.toUpperCase()}-${i}`,
      stock: p.stock,
      variantGroupId: p.variantGroupId,
      attributes: p.attributes,
      status: 'active',
      isFeatured: i % 3 === 0,
      ratingAverage: 3.5 + ((i % 3) * 0.5),
      ratingCount: 4 + i,
    });
    created += 1;
  }

  console.log(`Products created: ${created} (skipped ${PRODUCTS.length - created} already present)`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
