// Turns college course codes into subject names people recognize:
// "MAC1105 MRG" -> "Math", "POS2041 70715" -> "Government", "BSC2010L" -> "Biology Lab".
// Covers Florida's statewide course prefixes plus common ones used elsewhere
// ("HIST 1301", "CS 101"). Anything not recognized is left exactly as it was,
// so high school names like "AP US History - Period 3" stay readable.

const SUBJECTS = {
  English: ['ENC', 'ENG', 'ENGL', 'ENL', 'AML', 'LIT', 'CRW', 'REA', 'ENGW'],
  Math: ['MAC', 'MAT', 'MATH', 'MGF', 'MAP', 'MAS', 'MTH', 'MTG', 'MHF'],
  Stats: ['STA', 'STAT', 'QMB'],
  Coding: ['COP', 'COT', 'CEN', 'CAP', 'CS', 'CSC', 'CSCI', 'COSC', 'CIS', 'COMP', 'CPS', 'CSE', 'ITP'],
  Computers: ['CGS', 'CTS', 'CNT', 'CET', 'CIT', 'ISM'],
  Government: ['POS', 'POLS', 'GOVT', 'GOV', 'POLI', 'PUP', 'INR', 'CPO'],
  History: ['AMH', 'WOH', 'EUH', 'HIS', 'HIST', 'HST', 'LAH', 'AFH'],
  Biology: ['BSC', 'BIO', 'BIOL', 'PCB', 'MCB', 'ZOO', 'BOT', 'APB'],
  Chemistry: ['CHM', 'CHEM', 'BCH'],
  Physics: ['PHY', 'PHYS', 'PHZ'],
  Astronomy: ['AST', 'ASTR', 'AST'],
  Geology: ['GLY', 'GEOL', 'ESC', 'OCE'],
  'Environmental Science': ['EVR', 'ENV', 'ENVS'],
  Psychology: ['PSY', 'PSYC', 'DEP', 'CLP', 'SOP', 'EXP', 'PPE'],
  Sociology: ['SYG', 'SOC', 'SOCI', 'SYD', 'SYO'],
  Economics: ['ECO', 'ECON', 'ECN', 'ECS'],
  Accounting: ['ACG', 'ACC', 'ACCT', 'TAX'],
  Business: ['GEB', 'MAN', 'MAR', 'BUS', 'BUSI', 'FIN', 'MGMT', 'MKT', 'BUL'],
  Spanish: ['SPN', 'SPAN'],
  French: ['FRE', 'FREN'],
  Art: ['ART', 'ARH', 'ARTS', 'ARTH'],
  Music: ['MUH', 'MUS', 'MUL', 'MUSI', 'MUT', 'MUN'],
  Philosophy: ['PHI', 'PHIL', 'PHH'],
  Speech: ['SPC', 'SPCH', 'COMM', 'COM'],
  Humanities: ['HUM', 'HUMA'],
  Geography: ['GEO', 'GEOG', 'GEA'],
  Anthropology: ['ANT', 'ANTH'],
  Nursing: ['NUR', 'NURS', 'NSG'],
  Health: ['HSC', 'HLTH', 'HUN', 'PET', 'PEM', 'KIN'],
  'Student Success': ['SLS'],
  Education: ['EDF', 'EDU', 'EDUC', 'EME'],
  Criminology: ['CCJ', 'CJ', 'CRIM', 'CJE', 'CJL'],
};

const BY_PREFIX = new Map();
for (const [name, prefixes] of Object.entries(SUBJECTS)) {
  for (const p of prefixes) BY_PREFIX.set(p, name);
}

// "MAC1105 MRG", "HIST 1301-02", "BSC2010L", "ENC1101 Lab Requirements"
const CODE = /^([A-Z]{2,4})[\s-]?(\d{3,4})([A-Z])?\b(.*)$/;

function friendlyCourse(course) {
  if (!course) return course;
  const m = String(course).trim().match(CODE);
  if (!m) return course;
  const subject = BY_PREFIX.get(m[1]);
  if (!subject) return course;
  const isLab = m[3] === 'L' || /\blab\b/i.test(m[4]);
  return isLab ? `${subject} Lab` : subject;
}

module.exports = { friendlyCourse };
