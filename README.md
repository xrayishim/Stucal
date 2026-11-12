# Stucal

Stucal texts students before their Canvas assignments are due. It's free.

> **Stucal:** Lab Report 3 (CHEM-101-02) is due tomorrow at 11:59 PM. Reply STOP to opt out.

## What it does

- **Login by text.** Students enter a phone number and type in the code they get. There are no passwords.
- **Connect Canvas once.** Students paste their Canvas calendar link, and Stucal imports every assignment and re-checks it every hour. If a teacher moves a deadline, the reminder moves with it. Calendar links from Blackboard, Moodle and Google Classroom work too.
- **Add things Canvas doesn't have,** such as MyMathLab homework when the teacher doesn't sync it.
- **Students choose when the text arrives:** 1, 3, 12, 24 or 48 hours before the deadline.
- **Each assignment gets exactly one text,** and assignments checked off get none.

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

1. **Twilio** (sending texts): buy a phone number and fill in the `TWILIO_*` values in `.env.example`. US numbers must complete A2P 10DLC registration before carriers deliver the texts. Plan for about 1–2 weeks of approval and a small one-time fee. Twilio handles STOP and opt-outs automatically.
2. **Hosting:** use any always-on Node host, such as Railway, Render or Fly.io. The app needs a persistent disk for the SQLite file (`DB_PATH`). Set `NODE_ENV=production`.

Running costs are roughly $0.20–0.30 per student per month in texts, plus about $1–2/month for the Twilio number and about $5/month for hosting.

## Coming later

- AI texting: "what's due this week?", "add bio quiz friday 2pm", "done with the lab report"
- A daily "any new MyMathLab homework?" check-in text
- A Sunday night summary of the week
- A second reminder if something isn't marked done
- A paid plan

## Code map

- `src/server.js`: API routes, login and the background timers
- `src/reminders.js`: decides who gets texted and writes the message
- `src/calendar.js`: reads Canvas and other calendar feeds (.ics)
- `src/sms.js`: sends texts through Twilio, or prints them in dev mode
- `src/db.js`: SQLite schema
- `public/index.html`: the whole student-facing page
