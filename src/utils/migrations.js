const mongoose = require('mongoose');
const cloudinary = require('../config/cloudinary');
const Seller = require('../models/Seller');
const Category = require('../models/Category');
const { isEncrypted } = require('./fieldCrypto');

// One-time data migrations, run at boot. Each runs once per database: the
// first instance to insert its name into `migrations` runs it (concurrent
// Cloud Run instances lose the unique-key race and skip). A failed
// migration removes its record so the next boot retries it.
const Migration = mongoose.models.Migration || mongoose.model(
  'Migration',
  new mongoose.Schema({ name: { type: String, unique: true, required: true }, finishedAt: Date, result: String }, { timestamps: true })
);

// Seller KYC documents uploaded before they were made private are still
// publicly reachable on Cloudinary — move each to "private" delivery.
async function privatizeSellerDocuments() {
  const sellers = await Seller.find({ 'documents.0': { $exists: true } });
  let moved = 0;
  let failed = 0;
  for (const seller of sellers) {
    let changed = false;
    for (const doc of seller.documents) {
      if (doc.deliveryType === 'private') continue;
      const resourceType = (doc.url.match(/\/(image|raw|video)\/upload\//) || [])[1] || 'image';
      try {
        await cloudinary.uploader.rename(doc.publicId, doc.publicId, {
          type: 'upload',
          to_type: 'private',
          resource_type: resourceType,
          invalidate: true,
        });
      } catch (err) {
        const message = err?.message || err?.error?.message || String(err);
        // Already moved by an earlier partial run — just record it.
        if (!/not found/i.test(message)) {
          failed += 1;
          console.error(`[migration] could not privatize document ${doc.publicId}: ${message}`);
          continue;
        }
      }
      doc.deliveryType = 'private';
      doc.url = doc.url.replace('/upload/', '/private/').replace(/\/s--[^/]+--\//, '/');
      doc.resourceType = resourceType;
      doc.format = doc.format || (doc.url.match(/\.([a-z0-9]+)(?:\?|$)/i) || [])[1];
      changed = true;
      moved += 1;
    }
    if (changed) await seller.save();
  }
  if (failed) throw new Error(`${failed} document(s) could not be made private (moved ${moved})`);
  return `moved ${moved} document(s) to private`;
}

// Aadhaar / bank account numbers stored in plain text before field
// encryption existed — re-saving runs Seller's pre('save') encryption.
async function encryptSellerIdentifiers() {
  const sellers = await Seller.find({ $or: [{ aadhaarNumber: { $exists: true, $ne: '' } }, { 'bankDetails.accountNumber': { $exists: true, $ne: '' } }] });
  let encrypted = 0;
  for (const seller of sellers) {
    let changed = false;
    if (seller.aadhaarNumber && !isEncrypted(seller.aadhaarNumber)) {
      seller.markModified('aadhaarNumber');
      changed = true;
    }
    if (seller.bankDetails?.accountNumber && !isEncrypted(seller.bankDetails.accountNumber)) {
      seller.markModified('bankDetails.accountNumber');
      changed = true;
    }
    if (changed) {
      await seller.save();
      encrypted += 1;
    }
  }
  return `encrypted identifiers for ${encrypted} seller(s)`;
}

// Categories created before `type` existed have none, so the size selector
// never appeared; also fixes the "Jewellry" typo.
const CATEGORY_TYPE_BY_SLUG = {
  ridas: 'clothing',
  topis: 'accessories',
  attars: 'other',
  jewelry: 'other',
  jewellery: 'other',
  jewellry: 'other',
  'home-decor': 'other',
  handicrafts: 'other',
};
async function fixCategories() {
  let typed = 0;
  for (const [slug, type] of Object.entries(CATEGORY_TYPE_BY_SLUG)) {
    const result = await Category.updateMany({ slug, $or: [{ type: { $exists: false } }, { type: null }] }, { $set: { type } });
    typed += result.modifiedCount;
  }
  const renamed = await Category.updateMany({ name: 'Jewellry' }, { $set: { name: 'Jewellery' } });
  return `typed ${typed} categor(ies), renamed ${renamed.modifiedCount}`;
}

// The original homepage seed advertised a "Golden Hour Sale" and "no fees
// this week" that never existed. Only those exact untouched seed strings
// are replaced — anything an admin has edited is left as is.
const HOMEPAGE_COPY_FIXES = {
  'Golden Hour Sale': 'New Arrivals',
  'Boutique heritage pieces, modern .': 'Boutique heritage pieces, made modern.',
  'Shop the Sale': 'Shop Now',
  'Zero Listing Fees': 'Sell on BohraMart',
  'List anything in minutes. No fees this week, and easy onboarding for community-verified sellers.':
    'List your products in minutes with easy onboarding for community-verified sellers.',
  '24/7 Support': 'WhatsApp Support',
};
async function fixHomepageCopy() {
  const collection = mongoose.connection.db.collection('homepagecontents');
  const docs = await collection.find({}).toArray();
  let changed = 0;
  for (const doc of docs) {
    const fix = (value) => {
      if (typeof value !== 'string' || !HOMEPAGE_COPY_FIXES[value]) return value;
      changed += 1;
      return HOMEPAGE_COPY_FIXES[value];
    };
    const heroSlides = (doc.heroSlides || []).map((slide) => ({ ...slide, tag: fix(slide.tag), title: fix(slide.title), subtitle: fix(slide.subtitle), cta: fix(slide.cta) }));
    const trustPoints = (doc.trustPoints || []).map((point) => ({ ...point, title: fix(point.title) }));
    await collection.updateOne({ _id: doc._id }, { $set: { heroSlides, trustPoints } });
  }
  return `replaced ${changed} outdated homepage text(s)`;
}

const MIGRATIONS = [
  ['2026-10-encrypt-seller-identifiers', encryptSellerIdentifiers],
  ['2026-10-privatize-seller-documents', privatizeSellerDocuments],
  ['2026-10-fix-categories', fixCategories],
  ['2026-10-fix-homepage-copy', fixHomepageCopy],
];

async function runMigrations() {
  for (const [name, fn] of MIGRATIONS) {
    try {
      await Migration.create({ name });
    } catch (err) {
      if (err.code === 11000) continue; // already ran (or running elsewhere)
      throw err;
    }
    try {
      const result = await fn();
      await Migration.updateOne({ name }, { finishedAt: new Date(), result });
      console.log(`[migration] ${name}: ${result}`);
    } catch (err) {
      await Migration.deleteOne({ name });
      console.error(`[migration] ${name} failed, will retry on next boot:`, err.message || err);
    }
  }
}

module.exports = { runMigrations };
