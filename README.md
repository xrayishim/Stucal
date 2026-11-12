# StuCal

StuCal reminds students before their Canvas assignments are due, by phone notification or text. It's free.

> StuCal: Lab Report 3 (CHEM-101-02) is due tomorrow at 11:59 PM. Reply STOP to opt out.

## What it does

- **Two ways to get reminders:**
  - **Notifications (works now, no approval needed).** Students add StuCal to their Home Screen and turn on notifications. No phone number or password is needed: StuCal remembers them on that device. Works on iPhone (iOS 16.4+, from the Home Screen), Android and desktop browsers.
  - **Texts (once Twilio is set up and approved).** Students sign up with their phone number and log in with a texted code. If Twilio keys are set, the sign-up page switches to this automatically.
- **Connect Canvas once.** Students paste their Canvas calendar link. StuCal imports every assignment (skipping school-wide events like breaks), re-checks hourly, follows moved deadlines and drops deleted assignments. Blackboard, Moodle and Google Classroom calendar links work too.
- **Plain subject names:** class codes like MAC1105 or POS2041 show as Math or Government.
- **Add from screenshot:** screenshot an assignment list (MyMathLab, McGraw Hill, a syllabus...) and Google's Gemini AI reads the names and due dates. Students review the list, then tap Add. Classes are matched to their Canvas classes when possible. Turned on by setting `GEMINI_API_KEY` (a free key from aistudio.google.com); optional `GEMINI_MODEL` (comma-separated list to try in order; default Flash-Lite first, then Flash, then numbered backups) and `SCAN_MAX_PER_DAY` (default 500 for the whole app; each person can do 20 a day). Screenshots aren't stored.
- **Or type it in by hand.**
- **Reminders at the time each person picks:** 1, 3, 12, 24 or 48 hours before something is due.
  - Assignments due the same day come together in one message.
  - **Texts only:** an optional Sunday night summary at 6 PM. It isn't sent as a notification because a long list doesn't fit.
- **Past-due assignments drop off** the list and aren't imported.

### Finding your Canvas calendar link

In the **Canvas app**: tap the three lines **☰** at the top left → **Settings** → **Subscribe to Calendar**, and copy that link. (On the Canvas website: **Calendar** → **Calendar Feed** at the bottom right.) StuCal's Connect Canvas box has a button that opens the Canvas app and a **Paste my link** button.

## Run it locally (no accounts needed)

```bash
npm install
npm start          # open http://localhost:3000
npm test
```

You need Node 22.13 or newer. Without Twilio keys, every text, including the login code, is printed in the terminal.

## Going live

### Notifications only (no waiting)

1. Host it somewhere always-on with a **persistent disk** (e.g. Render Starter plus a 1 GB disk at `/var/data`). This matters more than usual: the database holds everyone's accounts *and* the notification signing keys, and if those are lost, everyone has to set StuCal up again.
2. Set `NODE_ENV=production`, `DB_PATH=/var/data/stucal.db`, `APP_URL` (your https address) and `CONTACT_EMAIL`.
3. Share the link. On iPhone, friends open it in Safari, tap Share, then Add to Home Screen, then open StuCal from the Home Screen and follow the steps.

Optional: set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (make them with `npx web-push generate-vapid-keys`) to fix the notification keys yourself instead of storing them in the database.

### Adding texts

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
