# Stucal

Stucal texts students before their assignments are due. It costs $4.99 a month, and the first 14 days are free.

> **Stucal:** Lab Report 3 (CHEM-101-02) is due tomorrow at 11:59 PM. Reply STOP to opt out.

## What it does

- **Login by text.** Students enter a phone number and type in the code they get. There are no passwords.
- **Add assignments by hand,** or **paste a school calendar link** from Canvas, Blackboard, Moodle, Schoology or Google Classroom. Stucal then imports every assignment and re-checks the feed every hour. If a teacher moves a deadline, the reminder moves with it.
- **Students choose when the text arrives:** 1, 3, 12, 24 or 48 hours before the deadline.
- **Each assignment gets exactly one text,** and assignments marked done get none.
- **Billing goes through Stripe Checkout.** Students can cancel themselves through Stripe's billing portal.

## Run it locally (free, no accounts needed)

```bash
npm install
npm start          # open http://localhost:3000
npm test
```

You need Node 22.13 or newer. Without Twilio keys, every text, including the login code, is printed in the terminal.

## Going live

1. **Twilio** (sending texts): buy a phone number and fill in the `TWILIO_*` values in `.env.example`. US numbers must complete A2P 10DLC registration before carriers deliver the texts. Plan for about 1–2 weeks of approval and a small one-time fee. Twilio handles STOP and opt-outs automatically.
2. **Stripe** (getting paid): create a product with a $4.99/month recurring price and set `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID`. Then add a webhook pointing to `https://yourdomain/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`, and set `STRIPE_WEBHOOK_SECRET`.
3. **Hosting:** use any always-on Node host, such as Railway, Render or Fly.io. The app needs a persistent disk for the SQLite file (`DB_PATH`). Set `NODE_ENV=production` and `APP_URL`.

## Cost per student (rough)

| | per month |
|---|---|
| Texts (~20 reminders × ~$0.01 incl. carrier fees) | ~$0.20–0.30 |
| Stripe fee on $4.99 (2.9% + 30¢) | ~$0.44 |
| **Left over per subscriber** | **~$4.20** |

A Twilio number is about $1–2/month total, and hosting starts around $5/month, so a handful of subscribers covers the fixed costs.

## Code map

- `src/server.js`: API routes, login and the background timers
- `src/reminders.js`: decides who gets texted and writes the message
- `src/calendar.js`: reads school calendar feeds (.ics)
- `src/billing.js`: Stripe checkout, billing portal and webhook
- `src/sms.js`: sends texts through Twilio, or prints them in dev mode
- `src/db.js`: SQLite schema
- `public/index.html`: the whole student-facing page
