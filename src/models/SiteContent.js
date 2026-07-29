const mongoose = require('mongoose');

// One document per editable key, e.g. { key: 'global.footerCopyright', value: '...' }.
// Deliberately not a single big document — admins save one or a handful of
// keys at a time from the visual editor, and per-key documents make that a
// plain upsert instead of a read-modify-write race on one shared blob.
const siteContentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: String, default: '' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SiteContent', siteContentSchema);
