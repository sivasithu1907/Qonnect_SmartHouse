// Prints a new VAPID key pair for Web Push. Run once per environment (staging and production
// should use different keys) and paste the values into that environment's .env file.
// Nothing is written to disk.
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('# Add these lines to .env (keep the private key secret; do not commit it):');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('# Also set VAPID_SUBJECT to a mailto: address you monitor, for example:');
console.log('# VAPID_SUBJECT=mailto:ops@your-domain');
