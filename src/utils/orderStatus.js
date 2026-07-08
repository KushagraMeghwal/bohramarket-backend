const ITEM_STATUS_RANK = { placed: 0, packed: 1, shipped: 2, delivered: 3 };
const TERMINAL_ITEM_STATUSES = ['cancelled', 'rto'];

// The order is only as advanced as its least-advanced non-terminal item.
// If every item ended up in the same terminal state, the order takes that state.
const recalcOrderStatus = (order) => {
  const statuses = order.items.map((item) => item.itemStatus);
  const activeStatuses = statuses.filter((s) => !TERMINAL_ITEM_STATUSES.includes(s));

  if (activeStatuses.length === 0) {
    order.orderStatus = statuses.includes('rto') ? 'rto' : 'cancelled';
    return;
  }

  const minRank = Math.min(...activeStatuses.map((s) => ITEM_STATUS_RANK[s]));
  order.orderStatus = Object.keys(ITEM_STATUS_RANK).find((key) => ITEM_STATUS_RANK[key] === minRank);
};

module.exports = { ITEM_STATUS_RANK, TERMINAL_ITEM_STATUSES, recalcOrderStatus };
