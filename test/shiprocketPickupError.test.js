// Regression coverage for the retry-pickup-registration 502 bug: Shiprocket's
// POST /settings/company/addpickup rejects an address with no house/flat/road
// number with a double-JSON-encoded 422 body, e.g.
//   {"message":"{\"address\":[\"Address line 1 should have House no \\/ Flat
//   no \\/ Road no.\"]}","status_code":422}
// which sellerController.retryPickupRegistration used to forward as a bare
// 502 instead of extracting and returning the actual validation message.
//
// Run with: node --experimental-test-module-mocks --test test/
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const { parseShiprocketError } = require('../src/services/shiprocket.service');

// The exact payload Shiprocket returns for this error (reproduced from the
// live 422 response, including the double-encoding).
const SHIPROCKET_422_BODY = {
  message: '{"address":["Address line 1 should have House no \\/ Flat no \\/ Road no."]}',
  status_code: 422,
};

function makeShiprocketHttpError(status, responseBody) {
  const err = new Error(`Shiprocket POST /settings/company/addpickup failed (${status}): ${JSON.stringify(responseBody)}`);
  err.status = status;
  err.responseBody = responseBody;
  return err;
}

test('parseShiprocketError unwraps the double-encoded address validation message', () => {
  const err = makeShiprocketHttpError(422, SHIPROCKET_422_BODY);

  const { field, message } = parseShiprocketError(err);

  assert.equal(field, 'address');
  assert.equal(message, 'Address line 1 should have House no / Flat no / Road no.');
});

test('parseShiprocketError falls back to a plain string message when the body is not double-encoded', () => {
  const err = makeShiprocketHttpError(400, { message: 'Some other Shiprocket error', status_code: 400 });

  const { field, message } = parseShiprocketError(err);

  assert.equal(field, null);
  assert.equal(message, 'Some other Shiprocket error');
});

test('parseShiprocketError falls back to err.message when there is no response body at all (network error)', () => {
  const err = new Error('Shiprocket POST /settings/company/addpickup network error: getaddrinfo ENOTFOUND');

  const { field, message } = parseShiprocketError(err);

  assert.equal(field, null);
  assert.equal(message, err.message);
});

// --- Controller-level: the actual 502 bug -----------------------------------
// Mocks both the Seller model and sellerPickupRegistration.service so this
// runs without a real database or a real Shiprocket call, while exercising
// the exact code path that used to hardcode res.status(502).
test('POST /api/sellers/me/retry-pickup-registration returns a clean 4xx, not a 502, when Shiprocket rejects the address', async () => {
  const fakeSeller = {
    _id: 'seller123',
    businessName: 'Ram ji sweets',
    user: 'user123',
    pickupAddress: { line1: 'Near Bus Stand', city: 'Surat', state: 'Gujarat', pincode: '395001' },
    shiprocketPickupStatus: 'failed',
    shiprocketPickupError: undefined,
  };

  mock.module('../src/models/Seller.js', {
    exports: { default: { findOne: async () => fakeSeller } },
  });

  // Simulates registerShiprocketPickup's own catch block (see
  // sellerPickupRegistration.service.js), which already unwraps the
  // Shiprocket error via parseShiprocketError before returning here — this
  // mock stands in for that whole function so the test stays focused on the
  // controller's response-shaping, not the Shiprocket HTTP call itself.
  mock.module('../src/services/sellerPickupRegistration.service.js', {
    exports: {
      registerShiprocketPickup: async () => ({
        success: false,
        error: 'Address line 1 should have House no / Flat no / Road no.',
        field: 'address',
      }),
    },
  });

  const { retryPickupRegistration } = require('../src/controllers/sellerController');

  const req = { user: { _id: 'user123' } };
  let statusCode;
  let jsonBody;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
  };

  await retryPickupRegistration(req, res, () => {});

  assert.notEqual(statusCode, 502, 'must not return the old bare 502 Bad Gateway');
  assert.equal(statusCode, 422);
  assert.equal(jsonBody.field, 'address');
  assert.equal(jsonBody.message, 'Address line 1 should have House no / Flat no / Road no.');
  assert.ok(jsonBody.seller, 'response still carries the seller doc so the UI can refresh its badge');
});
