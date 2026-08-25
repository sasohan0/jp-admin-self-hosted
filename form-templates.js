// Pure form-template defaults, parsing, validation, and editing helpers.

const FORM_KINDS = ['enrollment', 'attendance'];
const FIELD_TYPES = ['text', 'email', 'paragraph', 'choice', 'checkbox', 'scale', 'date', 'time'];

const DEFAULT_FORM_TEMPLATE = {
  version: 1,
  enrollment: {
    title: '{cohort} Bootcamp Data Collection Form',
    description: 'Please fill out all details accurately for the bootcamp placement process. বাংলা ও English—দুই ভাষাতেই উত্তর দেওয়া যাবে।',
    collectEmail: true,
    fields: [
      { key: 'name', title: 'Your Name (আপনার পূর্ণ নাম)', type: 'text', required: true },
      { key: 'enrollmentEmail', title: 'Email (যে ইমেইল দিয়ে কোর্সে এনরোল করেছেন)', type: 'email', required: true, help: 'Please use the same email as your course enrollment. এই ইমেইল দিয়েই আপনার Discord ও attendance record মিলানো হবে।' },
      { key: 'phone', title: 'WhatsApp Number (আপনার WhatsApp নম্বর)', type: 'text', required: true, help: 'Include country code when possible, for example +8801XXXXXXXXX.' },
      { key: 'region', title: 'Current Region (Division) — আপনি বর্তমানে কোন বিভাগ বা দেশে আছেন?', type: 'choice', required: true, choices: ['Dhaka', 'Chattogram', 'Rajshahi', 'Khulna', 'Barishal', 'Sylhet', 'Rangpur', 'Mymensingh', 'Abroad'], other: true },
      { key: 'subregion', title: 'Current Subregion / Area — আপনার বর্তমান এলাকা', type: 'text', required: true, help: 'Example: Mirpur, Uttara, Cumilla, London, Dubai.' },
      { key: 'genderPreference', title: 'Gender (kept private and used only for team placement)', type: 'choice', required: true, choices: ['Female', 'Male', 'Prefer not to say'] },
      { key: 'studyStage', title: 'Current study stage', type: 'choice', required: true, choices: ['Graduated / not currently studying', 'University final year', 'University 1st–3rd year', 'College / HSC / board exams', 'School', 'Other'] },
      { key: 'availability', title: 'Current job-search availability', type: 'choice', required: true, choices: ['Full-time job ready now', 'Searching, but limited availability', 'Not job searching — study first'] },
      { key: 'jobFocus', title: 'Job Focus / Job preference (আপনার জব প্রেফারেন্স)', type: 'choice', required: true, choices: ['Remote', 'Onsite', 'Hybrid (Remote বা Onsite—দুইটিতেই আগ্রহী)'] },
      { key: 'onsiteAreas', title: 'অনসাইটে জব করতে ইচ্ছুক হলে কোন এরিয়াতে করবেন?', type: 'paragraph', required: false, help: 'Example: Dhaka, Chattogram, Sylhet. Remote-only হলে N/A লিখুন।' },
      { key: 'remoteReason', title: 'যদি Remote job focused হন, তার কারণ বিস্তারিত লিখুন। Onsite/Hybrid হলে N/A লিখুন।', type: 'paragraph', required: true },
      { key: 'education', title: 'আপনার বর্তমান শিক্ষাগত ব্যাকগ্রাউন্ড', type: 'choice', required: true, choices: ['CSE — Student', 'CSE — Graduate', 'Non-CSE — Student', 'Non-CSE — Graduate', 'HSC', 'Diploma'], other: true },
      { key: 'englishCommunication', title: 'আপনার English communication skill-এ নিজেকে কত দিবেন?', type: 'scale', required: true, min: 1, max: 5, lowLabel: 'Poor', highLabel: 'Excellent' },
      { key: 'experience', title: 'Experience (আপনার experience level)', type: 'choice', required: true, choices: ['Fresher', 'Experienced'] },
      { key: 'jobHolder', title: 'Currently Job Holder? (আপনি কি বর্তমানে কোনো চাকরি করছেন?)', type: 'choice', required: true, choices: ['Yes', 'No'] },
      { key: 'nextExam', title: 'আপনার next exam-এর সম্ভাব্য date কবে?', type: 'text', required: true, help: 'Example: April, next month, specific date, অথবা পরীক্ষা নেই।' },
      { key: 'jobMotivation', title: 'আপনি বর্তমানে কেন job করতে ইচ্ছুক?', type: 'paragraph', required: true },
      { key: 'resume', title: 'আপনার Resume link', type: 'text', required: true, help: 'Google Drive link হলে “Anyone with the link — Viewer” access দিন।' },
      { key: 'linkedin', title: 'আপনার LinkedIn link', type: 'text', required: true },
      { key: 'linkedinRestricted', title: 'আপনার LinkedIn account কি restricted?', type: 'choice', required: true, choices: ['No', 'Yes'] },
      { key: 'github', title: 'আপনার GitHub link', type: 'text', required: true },
      { key: 'portfolio', title: 'আপনার Portfolio link', type: 'text', required: false, help: 'Portfolio না থাকলে N/A লিখতে পারেন।' },
      { key: 'bestProject', title: 'Best project link (আপনার সেরা project)', type: 'text', required: true },
      { key: 'technologies', title: 'আপনি কোন কোন technology জানেন?', type: 'checkbox', required: true, choices: ['JavaScript', 'TypeScript', 'React.js', 'Next.js', 'Redux', 'Node.js', 'Express.js', 'Prisma', 'MongoDB', 'SQL', 'MySQL', 'PostgreSQL', 'NextAuth / Better Auth', 'Java', 'C / C++', 'Python', 'Stripe / Payment Gateway'], other: true },
      { key: 'positions', title: 'আপনি কোন কোন position-এ apply করতে চান?', type: 'checkbox', required: true, choices: ['Full Stack Developer', 'Frontend Developer', 'Backend Developer', 'Software Engineer'], other: true },
      { key: 'freeTimeSlots', title: 'দিনের কোন সময়ে আপনি minimum ১ ঘণ্টা free থাকেন?', type: 'checkbox', required: true, choices: ['সকাল ১১:০০ — ১:০০', 'দুপুর ৩:৩০ — ৫:০০', 'সন্ধ্যা ৭:০০ — ৯:০০'], other: true },
      { key: 'jobSeriousness', title: 'আপনার কি সত্যিই job দরকার এবং এই bootcamp নিয়ে serious?', type: 'choice', required: true, choices: ['হ্যাঁ—আমি নিয়মিত সময় দিতে ও task করতে প্রস্তুত', 'এখন খুব জরুরি নয়, তবে নিয়মিত continue করতে চাই', 'এখন job focus করতে পারব না / continue করতে চাই না'] },
      { key: 'specialReferral', title: 'Special referral পেতে আগ্রহী?', type: 'choice', required: true, choices: ['হ্যাঁ—আমি Discord resources দেখে resume, profile ও projects polish করছি', 'না / এখনো প্রস্তুত নই'] },
      { key: 'rulesCommitment', title: 'After entering Discord, will you read and follow the Rules, Resources and Job Hunting channels?', type: 'choice', required: true, choices: ['Yes — I will read and follow them', 'I need mentor guidance'] },
      { key: 'discordUsername', title: 'Discord Username (আপনার Discord username লিখুন)', type: 'text', required: true, help: 'Profile থেকে exact username copy করুন। Display name নয়; # tag প্রয়োজন নেই।' },
      { key: 'comments', title: 'আপনার কোনো মতামত, প্রশ্ন বা প্রয়োজনীয় support থাকলে লিখুন', type: 'paragraph', required: false },
    ],
  },
  attendance: {
    title: '{cohort} — Daily Attendance',
    description: 'Please submit once during the daily attendance window. একই enrollment email ব্যবহার করুন।',
    collectEmail: true,
    fields: [
      { key: 'attendanceDate', title: 'Date of attendance', type: 'date', required: true },
      { key: 'studentEmail', title: 'Student Email', type: 'email', required: true, help: 'Use the same email you submitted in the enrollment form.' },
      { key: 'experience', title: 'Experience', type: 'choice', required: true, choices: ['Fresher', 'Experienced'] },
      { key: 'jobHolder', title: 'Job Holder', type: 'choice', required: true, choices: ['Yes', 'No'] },
      { key: 'jobFocus', title: 'Job Focus', type: 'choice', required: true, choices: ['Hybrid', 'Remote', 'Onsite'] },
      { key: 'arrivalTime', title: 'Arrival Time', type: 'time', required: true },
      { key: 'mood', title: 'Overall Mood Today (1 = Very Poor, 5 = Excellent)', type: 'scale', required: true, min: 1, max: 5, lowLabel: 'Very Poor', highLabel: 'Excellent' },
      { key: 'interview', title: 'Faced Any Interview today?', type: 'choice', required: true, choices: ['Yes', 'No'] },
      { key: 'interviewShared', title: 'Shared Interview update on the Discord channel?', type: 'choice', required: true, choices: ['Yes', 'I will share right now', 'No interview faced today'] },
      { title: 'আজকের job preparation / application progress সংক্ষেপে লিখুন', type: 'paragraph', required: false },
      { title: 'কোনো blocker বা mentor support প্রয়োজন হলে লিখুন', type: 'paragraph', required: false },
    ],
  },
};

const ENGLISH_FORM_TEMPLATE = {
  version: 2,
  enrollment: {
    title: '{cohort} Bootcamp Data Collection Form',
    description: 'Please fill out all details accurately for the bootcamp placement process.',
    collectEmail: true,
    fields: [
      { key: 'name', title: 'Your Full Name', type: 'text', required: true },
      { key: 'enrollmentEmail', title: 'Course Enrollment Email', type: 'email', required: true, help: 'Use the same email address you used to enroll in the course. This email links your Discord, attendance, and placement records.' },
      { key: 'phone', title: 'WhatsApp Number', type: 'text', required: true, help: 'Include the country code when possible, for example +8801XXXXXXXXX.' },
      { key: 'region', title: 'Current Region, Division, or Country', type: 'choice', required: true, choices: ['Dhaka', 'Chattogram', 'Rajshahi', 'Khulna', 'Barishal', 'Sylhet', 'Rangpur', 'Mymensingh', 'Abroad'], other: true },
      { key: 'subregion', title: 'Current District or Area', type: 'text', required: true, help: 'Examples: Mirpur, Uttara, Cumilla, London, or Dubai.' },
      { key: 'genderPreference', title: 'Gender', type: 'choice', required: true, choices: ['Female', 'Male', 'Prefer not to say'], help: 'Kept private and used only for team placement.' },
      { key: 'studyStage', title: 'Current Study Stage', type: 'choice', required: true, choices: ['Graduated / not currently studying', 'University final year', 'University 1st–3rd year', 'College / HSC / board exams', 'School', 'Other'] },
      { key: 'availability', title: 'Current Job-search Availability', type: 'choice', required: true, choices: ['Full-time job ready now', 'Searching, but limited availability', 'Not job searching — study first'] },
      { key: 'jobFocus', title: 'Job Preference', type: 'choice', required: true, choices: ['Remote', 'Onsite', 'Hybrid (interested in both Remote and Onsite)'] },
      { key: 'onsiteAreas', title: 'Which areas can you work onsite in?', type: 'paragraph', required: false, help: 'Examples: Dhaka, Chattogram, or Sylhet. Enter N/A if you are remote-only.' },
      { key: 'remoteReason', title: 'If you are remote-focused, explain why. Enter N/A for Onsite or Hybrid.', type: 'paragraph', required: true },
      { key: 'education', title: 'Current Educational Background', type: 'choice', required: true, choices: ['CSE — Student', 'CSE — Graduate', 'Non-CSE — Student', 'Non-CSE — Graduate', 'HSC', 'Diploma'], other: true },
      { key: 'englishCommunication', title: 'English Communication Self-rating', type: 'scale', required: true, min: 1, max: 5, lowLabel: 'Poor', highLabel: 'Excellent' },
      { key: 'experience', title: 'Experience Level', type: 'choice', required: true, choices: ['Fresher', 'Experienced'] },
      { key: 'jobHolder', title: 'Are you currently employed?', type: 'choice', required: true, choices: ['Yes', 'No'] },
      { key: 'nextExam', title: 'When is your next expected exam?', type: 'text', required: true, help: 'Examples: April, next month, a specific date, or No upcoming exam.' },
      { key: 'jobMotivation', title: 'Why do you currently want a job?', type: 'paragraph', required: true },
      { key: 'resume', title: 'Resume Link', type: 'text', required: true, help: 'For Google Drive, enable “Anyone with the link — Viewer” access.' },
      { key: 'linkedin', title: 'LinkedIn Profile Link', type: 'text', required: true },
      { key: 'linkedinRestricted', title: 'Is your LinkedIn account restricted?', type: 'choice', required: true, choices: ['No', 'Yes'] },
      { key: 'github', title: 'GitHub Profile Link', type: 'text', required: true },
      { key: 'portfolio', title: 'Portfolio Link', type: 'text', required: false, help: 'Enter N/A if you do not have a portfolio.' },
      { key: 'bestProject', title: 'Best Project Link', type: 'text', required: true },
      { key: 'technologies', title: 'Which technologies do you know?', type: 'checkbox', required: true, choices: ['JavaScript', 'TypeScript', 'React.js', 'Next.js', 'Redux', 'Node.js', 'Express.js', 'Prisma', 'MongoDB', 'SQL', 'MySQL', 'PostgreSQL', 'NextAuth / Better Auth', 'Java', 'C / C++', 'Python', 'Stripe / Payment Gateway'], other: true },
      { key: 'positions', title: 'Which positions do you want to apply for?', type: 'checkbox', required: true, choices: ['Full Stack Developer', 'Frontend Developer', 'Backend Developer', 'Software Engineer'], other: true },
      { key: 'freeTimeSlots', title: 'When are you free for at least one hour?', type: 'checkbox', required: true, choices: ['11:00 AM — 1:00 PM', '3:30 PM — 5:00 PM', '7:00 PM — 9:00 PM'], other: true },
      { key: 'jobSeriousness', title: 'Do you genuinely need a job and are you serious about this bootcamp?', type: 'choice', required: true, choices: ['Yes — I am ready to give time regularly and complete tasks', 'It is not urgent, but I want to continue regularly', 'I cannot focus on jobs now / I do not want to continue'] },
      { key: 'specialReferral', title: 'Are you interested in receiving special referrals?', type: 'choice', required: true, choices: ['Yes — I am using the Discord resources to polish my resume, profiles, and projects', 'No / I am not ready yet'] },
      { key: 'rulesCommitment', title: 'After entering Discord, will you read and follow the Rules, Resources, and Job Hunting channels?', type: 'choice', required: true, choices: ['Yes — I will read and follow them', 'I need mentor guidance'] },
      { key: 'discordUsername', title: 'Discord Username', type: 'text', required: true, help: 'Copy the exact username from your Discord profile, not your display name.' },
      { key: 'comments', title: 'Comments, Questions, or Support Needed', type: 'paragraph', required: false },
    ],
  },
  attendance: {
    title: '{cohort} — Daily Attendance',
    description: 'Submit this form once during the daily attendance window. Use your course enrollment email.',
    collectEmail: true,
    fields: [
      { key: 'attendanceDate', title: 'Date of Attendance', type: 'date', required: true },
      { key: 'studentEmail', title: 'Student Email', type: 'email', required: true, help: 'Use the same email you submitted during enrollment.' },
      { key: 'experience', title: 'Experience Level', type: 'choice', required: true, choices: ['Fresher', 'Experienced'] },
      { key: 'jobHolder', title: 'Currently Employed?', type: 'choice', required: true, choices: ['Yes', 'No'] },
      { key: 'jobFocus', title: 'Job Preference', type: 'choice', required: true, choices: ['Hybrid', 'Remote', 'Onsite'] },
      { key: 'arrivalTime', title: 'Arrival Time', type: 'time', required: true },
      { key: 'mood', title: 'Overall Mood Today', type: 'scale', required: true, min: 1, max: 5, lowLabel: 'Very Poor', highLabel: 'Excellent' },
      { key: 'interview', title: 'Did you attend an interview today?', type: 'choice', required: true, choices: ['Yes', 'No'] },
      { key: 'interviewShared', title: 'Did you share your interview update in Discord?', type: 'choice', required: true, choices: ['Yes', 'I will share it now', 'No interview today'] },
      { title: 'Briefly describe today’s job preparation or application progress.', type: 'paragraph', required: false },
      { title: 'Describe any blocker or mentor support you need.', type: 'paragraph', required: false },
    ],
  },
};

const REQUIRED_KEYS = {
  enrollment: ['name', 'enrollmentEmail', 'phone', 'region', 'subregion', 'experience', 'jobHolder', 'jobFocus', 'discordUsername'],
  attendance: ['attendanceDate', 'studentEmail'],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultTemplate() {
  return clone(ENGLISH_FORM_TEMPLATE);
}

function normalizeKind(value) {
  const kind = String(value || '').toLowerCase();
  return FORM_KINDS.includes(kind) ? kind : '';
}

function sanitizeTemplateName(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
}

function inferFieldKey(kind, title) {
  const text = String(title || '').toLowerCase();
  const rules = kind === 'attendance' ? [
    ['attendanceDate', /date of attendance|attendance date/],
    ['studentEmail', /student email/],
    ['arrivalTime', /arrival time/],
    ['mood', /overall mood|mood today/],
    ['interviewShared', /shared interview|interview update/],
    ['interview', /faced any interview/],
    ['experience', /experience/],
    ['jobHolder', /job holder/],
    ['jobFocus', /job focus/],
  ] : [
    ['discordUsername', /discord username|discord id/],
    ['enrollmentEmail', /enroll.*email|email.*enroll|কোর্সে.*ইমেইল/],
    ['phone', /whatsapp|phone|mobile/],
    ['subregion', /subregion|area|এলাকা/],
    ['region', /region|division|বিভাগ/],
    ['jobHolder', /job holder|চাকরি করছেন/],
    ['jobFocus', /job focus|job preference|জব প্রেফারেন্স/],
    ['experience', /experience|এক্সপেরিয়েস/],
    ['name', /your name|full name|পূর্ণ নাম/],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || '';
}

function normalizeField(kind, field) {
  const out = { ...field };
  out.title = String(out.title || '').trim();
  out.type = FIELD_TYPES.includes(String(out.type || '').toLowerCase()) ? String(out.type).toLowerCase() : 'text';
  out.required = Boolean(out.required);
  if (out.id) {
    out.id = String(out.id).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 64);
    if (!out.id) delete out.id;
  }
  if (!out.key) delete out.key;
  if (['choice', 'checkbox'].includes(out.type)) {
    out.choices = (out.choices || []).map(String).map(x => x.trim()).filter(Boolean);
  } else {
    delete out.choices;
    delete out.other;
  }
  if (out.type === 'scale') {
    out.min = Number(out.min) || 1;
    out.max = Number(out.max) || 5;
  }
  return out;
}

function normalizeFields(kind, fields) {
  const explicitKeys = new Set(fields.map(field => field && field.key).filter(Boolean));
  return fields.map(field => {
    const out = normalizeField(kind, field || {});
    if (!out.key) {
      const inferred = inferFieldKey(kind, out.title);
      if (inferred && !explicitKeys.has(inferred)) {
        out.key = inferred;
        explicitKeys.add(inferred);
      }
    }
    return out;
  });
}

function normalizeTemplate(value) {
  const base = defaultTemplate();
  if (!value || typeof value !== 'object') return base;
  for (const kind of FORM_KINDS) {
    const source = value[kind];
    if (Array.isArray(source)) {
      base[kind].fields = normalizeFields(kind, source);
      continue;
    }
    if (!source || typeof source !== 'object') continue;
    base[kind] = {
      title: String(source.title || base[kind].title),
      description: String(source.description ?? base[kind].description),
      collectEmail: source.collectEmail !== false,
      fields: Array.isArray(source.fields)
        ? normalizeFields(kind, source.fields)
        : base[kind].fields,
    };
  }
  return base;
}

function parseFieldDefinition(input) {
  const segments = String(input || '').split('|').map(x => x.trim());
  const header = segments.shift() || '';
  const tokens = header.toLowerCase().split(/\s+/).filter(Boolean);
  const type = tokens.find(token => FIELD_TYPES.includes(token));
  if (!type) throw new Error(`Field type must be one of: ${FIELD_TYPES.join(', ')}`);
  const required = tokens.includes('required');
  if (!required && !tokens.includes('optional')) throw new Error('Specify `required` or `optional`.');
  const title = segments.shift();
  if (!title) throw new Error('Add the student-facing question after the first `|`.');
  const field = { title, type, required };
  if (type === 'choice' || type === 'checkbox') {
    field.choices = segments.filter(Boolean).filter(x => !/^other:?$/i.test(x));
    field.other = segments.some(x => /^other:?$/i.test(x));
    if (!field.choices.length) throw new Error(`${type} fields need at least one choice.`);
  } else if (type === 'scale') {
    field.min = Number(segments[0]) || 1;
    field.max = Number(segments[1]) || 5;
    if (segments[2]) field.lowLabel = segments[2];
    if (segments[3]) field.highLabel = segments[3];
  }
  return field;
}

function validateTemplate(value) {
  const template = normalizeTemplate(value);
  const errors = [];
  for (const kind of FORM_KINDS) {
    const form = template[kind];
    if (!form.title.trim()) errors.push(`${kind}: form title is empty`);
    if (!form.fields.length) errors.push(`${kind}: no questions`);
    const titles = new Set();
    const keys = new Set();
    form.fields.forEach((field, index) => {
      if (!field.title) errors.push(`${kind} #${index + 1}: title is empty`);
      const normalizedTitle = field.title.toLowerCase();
      if (titles.has(normalizedTitle)) errors.push(`${kind}: duplicate title “${field.title}”`);
      titles.add(normalizedTitle);
      if (field.key) {
        if (keys.has(field.key)) errors.push(`${kind}: duplicate bot key ${field.key}`);
        keys.add(field.key);
      }
      if (['choice', 'checkbox'].includes(field.type) && !field.choices?.length) {
        errors.push(`${kind} #${index + 1}: ${field.type} has no choices`);
      }
      if (field.type === 'scale' && !([0, 1].includes(field.min) && field.max >= 3 && field.max <= 10 && field.max > field.min)) {
        errors.push(`${kind} #${index + 1}: scale must use minimum 0 or 1 and maximum 3-10`);
      }
    });
    const missing = REQUIRED_KEYS[kind].filter(key => !keys.has(key));
    if (missing.length) errors.push(`${kind}: missing bot-required questions (${missing.join(', ')})`);
    if (Buffer.byteLength(JSON.stringify(form), 'utf8') > 8500) {
      errors.push(`${kind}: saved template exceeds the Apps Script per-value storage limit`);
    }
  }
  return { template, errors };
}

function restoreCore(value, requestedKind = 'all') {
  const template = normalizeTemplate(value);
  const defaults = defaultTemplate();
  const kinds = requestedKind === 'all' ? FORM_KINDS : [normalizeKind(requestedKind)].filter(Boolean);
  for (const kind of kinds) {
    const present = new Set(template[kind].fields.map(field => field.key).filter(Boolean));
    for (const key of REQUIRED_KEYS[kind]) {
      if (present.has(key)) continue;
      const field = defaults[kind].fields.find(item => item.key === key);
      if (field) template[kind].fields.push(clone(field));
    }
  }
  return template;
}

module.exports = {
  DEFAULT_FORM_TEMPLATE: ENGLISH_FORM_TEMPLATE,
  FIELD_TYPES,
  FORM_KINDS,
  REQUIRED_KEYS,
  defaultTemplate,
  inferFieldKey,
  normalizeKind,
  normalizeTemplate,
  parseFieldDefinition,
  restoreCore,
  sanitizeTemplateName,
  validateTemplate,
};
