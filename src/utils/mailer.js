const nodemailer = require('nodemailer');

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
} else {
  console.warn('[mailer] SMTP_HOST/SMTP_USER/SMTP_PASS not set — emails will be logged to the console instead of sent.');
}

// No SMTP configured (local dev, or not yet set up on this deployment) falls
// back to logging instead of throwing, so registration/OTP flows keep working
// end-to-end without real email delivery.
async function sendMail({ to, subject, html, text }) {
  if (!transporter) {
    console.log(`[mailer] (no SMTP configured) would send to ${to}: ${subject}\n${text || html}`);
    return;
  }
  await transporter.sendMail({ from: process.env.EMAIL_FROM || 'BohraMart <no-reply@bohramart.com>', to, subject, html, text });
}

async function sendOtpEmail(to, otp) {
  await sendMail({
    to,
    subject: 'Your BohraMart verification code',
    text: `Your BohraMart verification code is ${otp}. It expires in 10 minutes.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1f7a4d;">Verify your email</h2>
        <p>Your BohraMart verification code is:</p>
        <p style="font-size: 32px; font-weight: 700; letter-spacing: 6px;">${otp}</p>
        <p style="color: #666;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });
}

module.exports = { sendMail, sendOtpEmail };
