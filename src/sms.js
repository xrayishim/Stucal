// Sends texts through Twilio's REST API. With no Twilio credentials set,
// messages are printed to the console so the app can be run locally for free.
const crypto = require('node:crypto');

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = process.env;

const live = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM);

// Twilio error codes that mean "don't try this number again".
const OPTED_OUT = 21610;               // they texted STOP
const BAD_NUMBER = [21211, 21214, 21217, 21401, 21407, 21408, 21612, 21614];

// Texts made only of plain characters are billed in 160-character pieces.
// A single emoji, curly quote or fancy dash switches the whole text to
// 70-character pieces, roughly doubling the cost, so we swap those out.
function toPlain(text) {
  return String(text)
    .replace(/[‘’‚′`]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[  -   　]/g, ' ')
    .replace(/•/g, '-')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // é -> e
    .replace(/[^\x0A\x0D\x20-\x7E]/g, '')              // drop anything else (emoji etc.)
    .replace(/[ \t]{2,}/g, ' ');
}

class SmsError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
  get optedOut() { return this.code === OPTED_OUT; }
  // 4xx (other than rate limiting) won't succeed on retry; 5xx and network errors might.
  get permanent() { return this.optedOut || BAD_NUMBER.includes(this.code) || (this.status >= 400 && this.status < 500 && this.status !== 429); }
}

async function sendSms(to, body) {
  body = toPlain(body);
  if (!live) {
    console.log(`[sms:dev] to ${to}: ${body}`);
    return { dev: true };
  }
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new SmsError(`Twilio ${res.status}: ${err.message || 'send failed'}`, res.status, err.code);
  }
  return res.json();
}

// Confirms an incoming webhook really came from Twilio.
// https://www.twilio.com/docs/usage/security#validating-requests
function verifyTwilioRequest(url, params, signature) {
  if (!TWILIO_AUTH_TOKEN || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

module.exports = { sendSms, toPlain, verifyTwilioRequest, SmsError, live };
