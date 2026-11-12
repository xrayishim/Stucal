// Delivers a message to a user by text (if they signed up with a phone number
// and Twilio is set up) and by phone/browser notification (if they turned them on).
const webpush = require('web-push');
const db = require('./db');
const sms = require('./sms');

// ---------- notification signing keys (VAPID) ----------
// Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to fix them, otherwise they're made
// once and saved in the database. If they ever change, everyone has to turn
// notifications on again, so keep the database on a persistent disk.
function loadKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const get = db.prepare(`SELECT value FROM settings WHERE key = ?`);
  const saved = get.get('vapid');
  if (saved) return JSON.parse(saved.value);
  const keys = webpush.generateVAPIDKeys();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('vapid', ?)`).run(JSON.stringify(keys));
  return keys;
}

const keys = loadKeys();
// Apple rejects notifications unless this is a real https address or a mailto: link.
const appUrl = process.env.APP_URL || '';
const subject = process.env.CONTACT_EMAIL ? `mailto:${process.env.CONTACT_EMAIL}`
  : appUrl.startsWith('https://') ? appUrl : 'https://stucal.site';
webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

const subsFor = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?`);
const removeSub = db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`);
const markOptedOut = db.prepare(`UPDATE users SET opted_out = 1 WHERE id = ?`);

// Without Twilio keys (local testing), sendSms prints the text instead of sending it.
function canText(user) {
  return Boolean(user.phone) && !user.opted_out;
}

function hasPush(user) {
  return subsFor.all(user.id).length > 0;
}

// Can this person be reached at all right now?
function reachable(user) {
  return canText(user) || hasPush(user);
}

async function sendPush(user, push) {
  let delivered = 0, retry = false;
  for (const sub of subsFor.all(user.id)) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(push),
        { TTL: 24 * 3600, urgency: 'high' },
      );
      delivered++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        removeSub.run(sub.id); // they turned notifications off or removed the app
      } else {
        console.error(`notification failed for user ${user.id}:`, e.statusCode || '', e.body || e.message);
        if (!e.statusCode || e.statusCode >= 500 || e.statusCode === 429) retry = true;
      }
    }
  }
  return { delivered, retry };
}

// message: { text, push: { title, body, url? } }
// Returns { delivered, retry }: retry is true when nothing got through but trying again later might work.
async function notifyUser(user, message) {
  let delivered = 0, retry = false;

  if (canText(user) && message.text) {
    try {
      await sms.sendSms(user.phone, message.text);
      delivered++;
    } catch (e) {
      if (e.optedOut) {
        markOptedOut.run(user.id);
        console.log(`user ${user.id} has texted STOP; no more texts until they text START`);
      } else {
        console.error(`text failed for user ${user.id}:`, e.message);
        if (!e.permanent) retry = true;
      }
    }
  }

  if (message.push) {
    const p = await sendPush(user, message.push);
    delivered += p.delivered;
    retry = retry || p.retry;
  }

  return { delivered, retry: delivered === 0 && retry };
}

module.exports = { notifyUser, sendPush, reachable, canText, hasPush, publicKey: keys.publicKey, webpush };
