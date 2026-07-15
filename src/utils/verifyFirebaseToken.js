const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

// The Firebase project id is public (it's already embedded in the frontend's
// app.config.ts firebaseConfig), so a hardcoded fallback is safe — env just
// lets it be overridden without a redeploy if the project ever changes.
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'bohramart-6e152';

// Firebase ID tokens are RS256-signed by Google's securetoken service.
// Verifying them only needs these public keys, not a service account — so
// this avoids pulling in the full firebase-admin SDK for one JWT check.
const client = jwksClient({
  jwksUri: 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  cache: true,
  cacheMaxAge: 6 * 60 * 60 * 1000,
});

function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

// Resolves with the decoded token (sub, email, name, picture, email_verified)
// or rejects if the signature, issuer, audience or expiry don't check out.
function verifyFirebaseIdToken(idToken) {
  return new Promise((resolve, reject) => {
    if (!idToken || typeof idToken !== 'string') {
      return reject(new Error('Missing ID token'));
    }

    jwt.verify(
      idToken,
      getSigningKey,
      {
        algorithms: ['RS256'],
        audience: FIREBASE_PROJECT_ID,
        issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      },
      (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded);
      }
    );
  });
}

module.exports = { verifyFirebaseIdToken };
