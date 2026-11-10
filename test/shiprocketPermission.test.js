// Shiprocket permission refusals (403 on /courier/assign/awb) must be marked
// permanent with an actionable hint, and an AWB assigned by hand in the
// Shiprocket dashboard must be readable back. Uses a stubbed fetch — no
// network.
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.SHIPROCKET_EMAIL = 'api-user@example.com';
process.env.SHIPROCKET_PASSWORD = 'not-a-real-password';

const routes = {};
global.fetch = async (url, init = {}) => {
  const path = url.replace('https://apiv2.shiprocket.in/v1/external', '');
  const handler = routes[`${init.method || 'GET'} ${path}`];
  const { status, body } = handler ? handler() : { status: 404, body: { message: 'not stubbed' } };
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
routes['POST /auth/login'] = () => ({ status: 200, body: { token: 'stub-token' } });

const shiprocket = require('../src/services/shiprocket.service');
const { isRetryable } = require('../src/services/shiprocketRetry.service');

test('403 on AWB assignment is permanent, not retryable, and explains what to fix', async () => {
  routes['POST /courier/assign/awb'] = () => ({
    status: 403,
    body: { message: 'Unauthorized. You do not have permission for this action.', status_code: 403 },
  });

  await assert.rejects(shiprocket.assignAwb({ shipmentId: '123', courierId: '1' }), (err) => {
    assert.equal(err.status, 403);
    assert.equal(err.permanent, true);
    assert.equal(isRetryable(err), false);
    assert.match(err.adminHint, /KYC/);
    assert.match(err.adminHint, /Ship Now/);
    return true;
  });
});

test('reads back an AWB that was assigned from the Shiprocket dashboard', async () => {
  routes['GET /orders/show/555'] = () => ({
    status: 200,
    body: { data: { id: 555, shipments: { id: 777, awb: '19041234567890', courier: 'Delhivery Surface' } } },
  });
  assert.deepEqual(await shiprocket.getAssignedAwb('555'), { awb: '19041234567890', courierName: 'Delhivery Surface' });

  routes['GET /orders/show/556'] = () => ({ status: 200, body: { data: { id: 556, shipments: { id: 778, awb: '' } } } });
  assert.equal(await shiprocket.getAssignedAwb('556'), null);
});
