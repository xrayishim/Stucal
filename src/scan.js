// Reads a screenshot of an assignment list (MyMathLab, McGraw Hill, a syllabus...)
// with Google's Gemini AI and turns it into assignments with due dates.
// The image is sent to Gemini, read, and never stored by StuCal.
const { zonedToUtc } = require('./calendar');
const { friendlyCourse } = require('./subjects');

// Models to try, in order. If one is overloaded, over its free limit, or retired,
// StuCal moves on to the next. Flash-Lite goes first: it's fast, usually not busy,
// and plenty for reading dates off a list. The "-latest" names follow Google's newest
// versions; the numbered ones are backups. Set GEMINI_MODEL (comma-separated) to change the list.
const DEFAULT_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const MODELS = () => (process.env.GEMINI_MODEL ? process.env.GEMINI_MODEL.split(',').map((m) => m.trim()).filter(Boolean) : DEFAULT_MODELS);
// Keys pasted on a phone often pick up a hidden space or line break, which breaks the request.
const apiKey = () => String(process.env.GEMINI_API_KEY || '').replace(/\s+/g, '');
const enabled = () => Boolean(apiKey());

const SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Assignment name exactly as shown, e.g. "5.3 Homework"' },
          class: { type: 'string', description: 'One of the student\'s classes if it clearly matches, otherwise the class name shown, otherwise ""' },
          due_date: { type: 'string', description: 'YYYY-MM-DD' },
          due_time: { type: 'string', description: '24-hour HH:MM, or "" if no time is shown' },
        },
        required: ['title', 'class', 'due_date', 'due_time'],
      },
    },
  },
  required: ['assignments'],
};

function prompt({ today, weekday, classes }) {
  return [
    'This is a screenshot a student took of their assignment list (for example MyMathLab, McGraw Hill Connect, WebAssign or a syllabus).',
    'List every assignment, quiz, test or project that has a due date, including ones that are already past due and ones with a score or "see score" link. StuCal decides what to keep based on the date, so do not leave anything out because of its date or score.',
    `Today is ${weekday}, ${today}. If a date is written without a year, assume the current school year: use the year that puts it closest to today. "Today" and "tomorrow" are relative to today.`,
    'Skip only rows with no due date at all. Use the due date, not an open or start date.',
    classes.length
      ? `The student's classes are: ${classes.map((c) => `"${c.label}"`).join(', ')}. If the screenshot clearly belongs to one of them, use that exact text for class. Otherwise use the class name shown in the screenshot, or "" if none is shown.`
      : 'For class, use the class name shown in the screenshot, or "" if none is shown.',
    'Copy assignment names as written; do not invent anything that is not in the image.',
  ].join('\n');
}

class ScanError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// Asks one model. Returns { items } on success, or { retry: 'busy' | 'limit' | 'gone' | 'unreadable' } to try the next model.
async function askModel(model, imageBase64, mimeType, context) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: prompt(context) }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    console.error(`screenshot reading: ${model} could not be reached: ${e.name}: ${e.message}${e.cause ? ` / ${e.cause.code || ''} ${e.cause.message || ''}` : ''}`);
    return { retry: 'busy' };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body.error?.message || '';
    console.error(`screenshot reading: ${model} answered ${res.status}: ${message}`);
    if (res.status === 401 || res.status === 403 || /api key/i.test(message)) {
      console.error('screenshot reading: check that GEMINI_API_KEY in your settings is correct and active');
      throw new ScanError("Screenshot reading isn't working right now. Try again later.", 503);
    }
    if (res.status === 429) return { retry: 'limit' };
    if (res.status === 404) return { retry: 'gone' }; // model retired or renamed
    if (res.status >= 500) return { retry: 'busy' };
    return { retry: 'unreadable' };
  }
  const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  try {
    const parsed = JSON.parse(text);
    return { items: Array.isArray(parsed.assignments) ? parsed.assignments : [] };
  } catch {
    console.error(`screenshot reading: ${model} returned something that is not JSON:`, text.slice(0, 200));
    return { retry: 'unreadable' };
  }
}

async function askGemini(imageBase64, mimeType, context) {
  const problems = [];
  for (const model of MODELS()) {
    const result = await askModel(model, imageBase64, mimeType, context);
    if (result.items) return result.items;
    problems.push(result.retry);
  }
  if (problems.every((p) => p === 'limit')) throw new ScanError("StuCal's free AI limit is used up for now. Try again later.", 429);
  if (problems.every((p) => p === 'unreadable')) throw new ScanError("The AI couldn't read that screenshot. Try a clearer one.");
  throw new ScanError('The AI is busy right now. Try again in a few minutes.', 503);
}

// classes: the student's own class names from Canvas, e.g. ["MAC1105 MRG", "ENC1101 MRG"]
async function scanScreenshot({ imageBase64, mimeType, timezone, classes = [], now = new Date() }) {
  if (!enabled()) throw new ScanError('Screenshot import isn\'t turned on yet.', 503);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(now);

  // Show the AI friendly names ("Math (MAC1105 MRG)") so it can match "MyLab Math" to the right class.
  const options = classes.map((raw) => {
    const friendly = friendlyCourse(raw);
    return { raw, label: friendly && friendly !== raw ? `${friendly} (${raw})` : raw };
  });
  const raw = await askGemini(imageBase64, mimeType, { today, weekday, classes: options });

  const found = [];
  for (const item of raw.slice(0, 50)) {
    const title = String(item.title || '').trim().slice(0, 200);
    const m = String(item.due_date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!title || !m) continue;
    const t = String(item.due_time || '').match(/^(\d{1,2}):(\d{2})$/);
    const [h, mi] = t ? [Number(t[1]), Number(t[2])] : [23, 59]; // no time shown: end of that day
    const due = zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), h, mi, 0, timezone);
    if (isNaN(due) || due <= now) continue; // already past due

    // If it matched one of their classes, store that class (so it reads "Math"); otherwise keep what was shown, if anything.
    const cls = String(item.class || '').trim();
    const match = options.find((o) => o.label === cls || o.raw === cls);
    const course = match ? match.raw : cls.slice(0, 60) || null;
    found.push({ title, course, dueAt: due.toISOString() });
  }
  return found;
}

module.exports = { scanScreenshot, enabled, ScanError, MODELS };
