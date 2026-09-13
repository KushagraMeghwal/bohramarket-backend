// Shared by every caller that needs to register/re-register a seller's
// Shiprocket pickup location: the lazy fulfillment-chain step
// (fulfillment.service.js's ensure_pickup, triggered on first accepted
// order), eager onboarding-time registration (sellerController.approveSeller,
// PART 2.10), re-registration when the pickup address changes
// (sellerController.updateMyProfile), and a seller-triggered manual retry.
// One function updates shiprocketPickupStatus/Error/RegisteredAt
// consistently regardless of which caller triggered it, so none of those
// paths can leave the seller record in a different shape for the same
// underlying action.
const User = require('../models/User');
const shiprocketService = require('./shiprocket.service');
const notificationService = require('./notification.service');

async function registerShiprocketPickup(seller) {
  try {
    const sellerUser = await User.findById(seller.user).select('email');
    const sellerEmail = sellerUser?.email || 'orders@bohramart.example';

    const pickupLocationName = await shiprocketService.ensurePickupLocation(seller, sellerEmail);

    const wasFailing = seller.shiprocketPickupStatus === 'failed';
    seller.shiprocketPickupLocationName = pickupLocationName;
    seller.shiprocketPickupStatus = 'registered';
    seller.shiprocketPickupError = undefined;
    seller.shiprocketPickupRegisteredAt = new Date();
    await seller.save();

    if (wasFailing) {
      notificationService.notifySeller(seller._id, 'Your Shiprocket pickup address is now registered successfully.');
    }

    return { success: true, pickupLocationName };
  } catch (err) {
    // Shiprocket's validation errors are double-JSON-encoded (see
    // shiprocket.service.js's parseShiprocketError) — unwrap once here so
    // every caller (the seller's manual retry, admin approval, the
    // fulfillment chain's ensure_pickup step) gets the same clean
    // {field, message} shape instead of each having to re-parse the raw
    // "Shiprocket POST ... failed (422): {...}" string itself.
    const { field, message } = shiprocketService.parseShiprocketError(err);

    // Logged with the seller id and the exact address payload that was
    // sent, so a future Shiprocket rejection is diagnosable straight from
    // Cloud Run logs instead of only being visible as a bare error string
    // in the UI.
    console.error(
      `[shiprocket-pickup] registration failed for seller ${seller._id} (${seller.businessName}) — field=${field ?? 'n/a'} message="${message}" pickupAddress=${JSON.stringify(seller.pickupAddress)}`
    );

    seller.shiprocketPickupStatus = 'failed';
    seller.shiprocketPickupError = message;
    await seller.save();

    notificationService.notifySeller(
      seller._id,
      `Shiprocket pickup address registration failed: ${message}. Update your pickup address (Edit Profile) or use the Retry button — it's also retried automatically on your next accepted order.`
    );
    notificationService.notifyAdmin(`Seller ${seller._id} (${seller.businessName}) has a failed Shiprocket pickup registration: ${message}`);

    return { success: false, error: message, field };
  }
}

module.exports = { registerShiprocketPickup };
