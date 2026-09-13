// Provider-agnostic SMS adapter, selected via SMS_PROVIDER. Defaults to
// logging (safe for local/dev — never actually sends). Every send is
// failure-tolerant by construction: sendSms() never rejects, it only
// resolves after logging any failure internally — an SMS outage must never
// break order/fulfillment flow (see every call site's own "not awaited" or
// ".catch()" comments).
const { SMS_TEMPLATES } = require('../config/smsTemplates');

class ConsoleSmsProvider {
  async send(to, message, templateKey) {
    console.log(`[sms:console] to=${to} template=${templateKey} :: ${message}`);
  }
}

// Stub — no Msg91 account/credentials exist to verify a real request shape
// against (same "don't invent field names" caveat as the Shiprocket work).
// Implement the real HTTP call once SMS_API_KEY/SMS_SENDER_ID and each
// template's DLT_TEMPLATE_ID_<KEY> env var are available.
class Msg91Provider {
  async send(to, message, templateKey) {
    throw new Error(
      `Msg91Provider is a stub (SMS_PROVIDER=msg91 selected but not implemented). Set SMS_PROVIDER=console for local/dev, or implement the real Msg91 send call once account credentials + DLT template IDs exist.`
    );
  }
}

// Stub — same reasoning as Msg91Provider. Also note: Twilio itself is not
// DLT-registered for India: sending transactional SMS to Indian numbers
// through it requires a DLT-compliant route regardless (e.g. via an
// India-licensed aggregator), not just an API key.
class TwilioProvider {
  async send(to, message, templateKey) {
    throw new Error(
      `TwilioProvider is a stub (SMS_PROVIDER=twilio selected but not implemented). Set SMS_PROVIDER=console for local/dev, or implement the real Twilio send call once account credentials exist (and a DLT-compliant India route).`
    );
  }
}

function resolveProvider() {
  switch ((process.env.SMS_PROVIDER || 'console').toLowerCase()) {
    case 'msg91':
      return new Msg91Provider();
    case 'twilio':
      return new TwilioProvider();
    case 'console':
    default:
      return new ConsoleSmsProvider();
  }
}

const provider = resolveProvider();

async function sendSms({ to, templateKey, vars = {} }) {
  const buildMessage = SMS_TEMPLATES[templateKey];
  if (!buildMessage) {
    console.error(`[sms] unknown templateKey "${templateKey}" — not sending`);
    return;
  }
  if (!to) {
    console.warn(`[sms] no recipient phone number for templateKey "${templateKey}" — not sending`);
    return;
  }

  const message = buildMessage(vars);

  try {
    await provider.send(to, message, templateKey);
  } catch (err) {
    console.error(`[sms] send failed (provider=${process.env.SMS_PROVIDER || 'console'}, templateKey=${templateKey}, to=${to}):`, err.message || err);
  }
}

// Admin/seller operational alerts (pickup registration failed, unserviceable
// pincode, job needs_attention, etc.) have no dedicated delivery channel in
// this codebase — no admin phone/email broadcast list, no Slack webhook, and
// PART 2.7's template list is customer-SMS-only. Logged loudly so it's at
// least visible in Cloud Run logs, and duplicated onto the DB-query-driven
// "needs attention" surfaces built in PART 2.12, which don't depend on
// anyone watching logs. Replace with real email/Slack/push once a channel
// exists — deliberately not invented here.
function notifyAdmin(message) {
  console.warn(`[admin-notify] ${message}`);
}

function notifySeller(sellerId, message) {
  console.warn(`[seller-notify:${sellerId}] ${message}`);
}

module.exports = { sendSms, notifyAdmin, notifySeller };
