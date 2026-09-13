// SMS message bodies, keyed the same way across every provider.
//
// IMPORTANT — India DLT requirement: telecom operators reject any
// transactional SMS to an Indian number whose content doesn't exactly match
// a pre-approved, DLT (Distributed Ledger Technology) -registered template
// for the sender's registered entity. The `text` functions below are a
// LOCAL fallback/preview — what ConsoleSmsProvider prints, and what a
// provider would fall back to if it takes freeform text — but a real send
// through Msg91/Twilio/etc. must reference that provider's own DLT template
// ID for this templateKey, not this string verbatim. See
// notification.service.js's provider stubs for where a DLT_TEMPLATE_ID_<KEY>
// env var would be read once a real account exists.
const SMS_TEMPLATES = {
  ORDER_PLACED: (vars) => `BohraMart: Your order ${vars.orderNumber} has been placed. We'll notify you once it's confirmed.`,
  ORDER_CONFIRMED: (vars) => `BohraMart: Your order ${vars.orderNumber} is confirmed and shipping soon.`,
  SHIPPED: (vars) =>
    `BohraMart: Your order ${vars.orderNumber} has shipped${vars.awbNumber ? ` (AWB ${vars.awbNumber})` : ''}.${
      vars.trackingUrl ? ` Track: ${vars.trackingUrl}` : ''
    }`,
  OUT_FOR_DELIVERY: (vars) => `BohraMart: Your order ${vars.orderNumber} is out for delivery today.`,
  DELIVERED: (vars) => `BohraMart: Your order ${vars.orderNumber} has been delivered. Thank you for shopping with us!`,
  CANCELLED: (vars) =>
    `BohraMart: Your order ${vars.orderNumber}${vars.itemName ? ` (${vars.itemName})` : ''} was cancelled.${
      vars.reason ? ` Reason: ${vars.reason}.` : ''
    }${vars.refund ? ' A refund will be processed.' : ''}`,
  RETURN_INITIATED: (vars) =>
    `BohraMart: A return has been initiated for order ${vars.orderNumber}.${
      vars.returnAwbNumber ? ` Pickup AWB: ${vars.returnAwbNumber}.` : ''
    }`,
  RETURN_PICKED: (vars) => `BohraMart: Your return for order ${vars.orderNumber} has been picked up.`,
  REFUND_INITIATED: (vars) => `BohraMart: A refund for order ${vars.orderNumber} has been initiated and will reflect in 5-7 business days.`,
};

module.exports = { SMS_TEMPLATES };
