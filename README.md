# StuCal

StuCal texts students before their Canvas assignments are due. It's free.

> StuCal: Lab Report 3 (CHEM-101-02) is due tomorrow at 11:59 PM. Reply STOP to opt out.

## What it does

- **Login by text.** Students enter a phone number and type in the code they get. There are no passwords.
- **Connect Canvas once.** Students paste their Canvas calendar link, and StuCal imports every assignment and re-checks it every hour. If a teacher moves a deadline, the reminder moves with it. Calendar links from Blackboard, Moodle and Google Classroom work too.
- **Add things Canvas doesn't have,** such as MyMathLab homework when the teacher doesn't sync it.
- **Sunday night summary:** at 6 PM local time every Sunday, one text lists everything due in the coming week, grouped by day. Students can turn it off.
- **Day-before reminder:** by default, a text 1 day before each assignment is due (students can pick 1, 3, 12, 24 or 48 hours). Assignments due the same day come in one text.
- **Each assignment gets exactly one reminder,** and assignments checked off get none.

### Finding your Canvas calendar link

In Canvas, open **Calendar**, then click **Calendar Feed** at the bottom right and copy the link.

## Run it locally (no accounts needed)

```bash
npm install
npm start          # open http://localhost:3000
npm test
```

You need Node 22.13 or newer. Without Twilio keys, every text, including the login code, is printed in the terminal.

## Going live

1. **Twilio** (sending texts): buy a phone number and fill in the `TWILIO_*` values in `.env.example`.
   - In the Twilio console, set the number's **"A message comes in"** webhook to `https://YOUR-DOMAIN/api/sms/incoming` (HTTP POST). That's how StuCal learns when someone texts STOP or START.
   - Under **Messaging → Settings → Geo permissions**, allow only the United States and Canada. This is a second layer of protection against SMS fraud.
   - Register for **A2P 10DLC** (required for US texting; about 1–2 weeks). The form asks for your opt-in wording and Privacy/Terms links, which are already on the site: the consent line under the phone box, `/privacy` and `/terms`.
2. **Hosting:** use any always-on Node host, such as Railway, Render or Fly.io. The app needs a persistent disk for the SQLite file (`DB_PATH`). Set `NODE_ENV=production`, `APP_URL` (your public address) and `CONTACT_EMAIL` (shown on the Privacy and Terms pages).

### Built-in protections

- **Login codes are limited:** 1 per minute and 5 per hour per number, 10 per hour per visitor, and an app-wide cap (`MAX_CODES_PER_HOUR`, default 300). Only US/Canada mobile numbers are accepted; Caribbean +1 and toll-free numbers are rejected.
- **STOP is respected:** people who text STOP get no more reminders, and StuCal doesn't keep retrying them. START turns texts back on.
- **Other replies** get one auto-answer per day at most, so nobody can run up your bill by texting the number.
- **Texts use plain characters only** (no emoji or fancy punctuation), which keeps long texts at the cheaper billing rate.
- **Students can delete their account** from the bottom of their dashboard.

The Privacy Policy and Terms are a solid starting point written for this app, but they aren't legal advice. Have someone check them if StuCal grows.

Running costs are roughly $0.20–0.30 per student per month in texts, plus about $1–2/month for the Twilio number and about $5/month for hosting.

## Coming later

- AI texting: "what's due this week?", "add bio quiz friday 2pm", "done with the lab report"
- A daily "any new MyMathLab homework?" check-in text
- A second reminder if something isn't marked done
- A paid plan

## Code map

- `src/server.js`: API routes, login and the background timers
- `src/reminders.js`: decides who gets texted and writes the message
- `src/calendar.js`: reads Canvas and other calendar feeds (.ics)
- `src/sms.js`: sends texts through Twilio, or prints them in dev mode
- `src/db.js`: SQLite schema
- `public/index.html`: the whole student-facing page
