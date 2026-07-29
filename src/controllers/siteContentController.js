const SiteContent = require('../models/SiteContent');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/site-content — public. Returns everything an admin has ever saved
// as a flat { key: value } map; the frontend layers this over its own
// built-in defaults (see editable-sections.ts FALLBACK_CONTENT), so a key
// with nothing saved here just falls back to the default copy already in
// the page — this endpoint only ever needs to return *overrides*.
const getSiteContent = asyncHandler(async (req, res) => {
  const entries = await SiteContent.find();
  const content = {};
  entries.forEach((entry) => {
    content[entry.key] = entry.value;
  });
  res.json({ content });
});

// PUT /api/site-content (admin only) — bulk upsert. Body: { values: { key: value, ... } }
const saveSiteContent = asyncHandler(async (req, res) => {
  const { values } = req.body;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return res.status(400).json({ message: 'values must be an object of { key: value }' });
  }

  const keys = Object.keys(values);
  if (!keys.length) {
    return res.status(400).json({ message: 'No keys provided' });
  }

  await Promise.all(
    keys.map((key) =>
      SiteContent.findOneAndUpdate(
        { key },
        { value: String(values[key] ?? ''), updatedBy: req.user._id },
        { upsert: true, new: true }
      )
    )
  );

  const entries = await SiteContent.find({ key: { $in: keys } });
  const content = {};
  entries.forEach((entry) => {
    content[entry.key] = entry.value;
  });
  res.json({ content });
});

// POST /api/site-content/upload-image (admin only) — uploads a single image
// and hands back its URL, mirroring homepageController's uploadHomepageImage
// — the editor attaches the returned URL to a key before the surrounding
// PUT /api/site-content save.
const uploadSiteContentImage = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }
  res.json({ image: { url: req.file.path, publicId: req.file.filename } });
});

module.exports = { getSiteContent, saveSiteContent, uploadSiteContentImage };
