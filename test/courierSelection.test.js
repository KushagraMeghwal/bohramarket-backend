const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectCourier } = require('../src/services/courierSelection.service');

const couriers = [
  { courier_company_id: 1, courier_name: 'Slow Cheap', rate: 60, etd: '31 days', cod: 1 },
  { courier_company_id: 2, courier_name: 'Fast', rate: 95, etd: '3 days', cod: 1 },
  { courier_company_id: 3, courier_name: 'Mid', rate: 75, etd: '5 days', cod: 0 },
];

test("default 'balanced' strategy skips a 31-day courier when faster ones exist", () => {
  const chosen = selectCourier(couriers, { paymentMethod: 'online' });
  assert.equal(chosen.courierName, 'Mid');
  assert.equal(chosen.estimatedDeliveryDays, 5);
});

test('COD only considers COD-capable couriers', () => {
  const chosen = selectCourier(couriers, { paymentMethod: 'COD' });
  assert.equal(chosen.courierName, 'Fast');
});

test("explicit 'cheapest' still picks the lowest rate", () => {
  const chosen = selectCourier(couriers, { paymentMethod: 'online', strategy: 'cheapest' });
  assert.equal(chosen.courierName, 'Slow Cheap');
});
