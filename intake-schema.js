// Pure enrollment-template -> portal-field conversion and submission validation.

const CORE_KEYS = ['name', 'enrollmentEmail', 'phone', 'region', 'subregion'];
const URL_KEYS = new Set(['resume', 'linkedin', 'github', 'portfolio', 'bestProject']);

function slug(value) {
  return String(value || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
}

function fieldId(field, index) {
  const explicit = slug(field?.key);
  const durable = slug(field?.id);
  return explicit || durable || `q_${index + 1}_${slug(field?.title) || 'question'}`;
}

function portalFieldsFromTemplate(template) {
  const source = template?.enrollment?.fields || [];
  return source.map((field, index) => ({
    id: fieldId(field, index),
    key: String(field?.key || '').trim(),
    title: String(field?.title || `Question ${index + 1}`).trim(),
    help: String(field?.help || '').trim(),
    type: String(field?.type || 'text').toLowerCase(),
    required: Boolean(field?.required),
    choices: Array.isArray(field?.choices) ? field.choices.map(String) : [],
    other: Boolean(field?.other),
    min: Number(field?.min) || 1,
    max: Number(field?.max) || 5,
    lowLabel: String(field?.lowLabel || '').trim(),
    highLabel: String(field?.highLabel || '').trim(),
  })).filter(field => field.key !== 'discordUsername');
}

function clean(value, max = 4000) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function onboardingAnswers(byKey) {
  const gender = {
    female: 'female', male: 'male', 'prefer not to say': 'private',
  }[String(byKey.genderPreference || '').trim().toLowerCase()] || '';
  const region = clean(byKey.region, 100);
  const division = ['Barishal', 'Chattogram', 'Dhaka', 'Khulna', 'Mymensingh', 'Rajshahi', 'Rangpur', 'Sylhet', 'Abroad']
    .includes(region) ? region : (region ? 'Other' : '');
  const availabilityText = String(byKey.availability || '').toLowerCase();
  const availability = availabilityText.includes('full-time')
    ? 'full_time'
    : availabilityText.includes('limited')
      ? 'limited'
      : availabilityText.includes('study first') || availabilityText.includes('not job searching')
        ? 'study' : '';
  const stageText = String(byKey.studyStage || '').toLowerCase();
  let studyStage = '';
  if (stageText.includes('graduated')) studyStage = 'graduated';
  else if (stageText.includes('final year')) studyStage = 'university_final';
  else if (/1st|2nd|3rd|early/.test(stageText)) studyStage = 'university_early';
  else if (/college|hsc|board/.test(stageText)) studyStage = 'college';
  else if (stageText === 'school') studyStage = 'school';
  else if (stageText) studyStage = 'other';
  return { gender, division, availability, studyStage };
}

function normalizeAnswer(field, params) {
  const values = params.getAll(field.id).map(value => clean(value, 1000)).filter(Boolean);
  const other = clean(params.get(`${field.id}__other`), 1000);
  if (field.type === 'checkbox') {
    const allowed = new Set(field.choices);
    const selected = values.filter(value => allowed.has(value));
    if (values.includes('__other__') && other) selected.push(other);
    return [...new Set(selected)].join(', ');
  }
  let value = values[0] || '';
  if (['choice'].includes(field.type)) {
    if (value === '__other__' && field.other) return other;
    if (!field.choices.includes(value)) return '';
  }
  return clean(value, field.type === 'paragraph' ? 4000 : 1000);
}

function validateIntakeSubmission(fields, params) {
  const errors = [];
  const answers = [];
  const byKey = {};
  for (const field of fields) {
    let value = normalizeAnswer(field, params);
    if (field.required && !value) errors.push(`${field.title} is required.`);
    if (field.type === 'email' && value) {
      value = value.toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        errors.push(`${field.title} must be a valid email address.`);
      }
    }
    if (field.type === 'scale' && value) {
      const score = Number(value);
      if (!Number.isInteger(score) || score < field.min || score > field.max) {
        errors.push(`${field.title} must be between ${field.min} and ${field.max}.`);
      }
    }
    if (URL_KEYS.has(field.key) && value && !/^n\/?a$/i.test(value) && !isHttpUrl(value)) {
      errors.push(`${field.title} must be a complete http:// or https:// link.`);
    }
    answers.push({ key: field.id, semanticKey: field.key, title: field.title, value });
    if (field.key) byKey[field.key] = value;
  }

  const missingCore = CORE_KEYS.filter(key => !byKey[key]);
  if (missingCore.length) {
    errors.push(`The active enrollment template is missing required intake answers: ${missingCore.join(', ')}.`);
  }
  const phoneDigits = String(byKey.phone || '').replace(/\D/g, '');
  if (byKey.phone && (phoneDigits.length < 8 || phoneDigits.length > 15)) {
    errors.push('Phone / WhatsApp number must contain 8 to 15 digits.');
  }
  const email = String(byKey.enrollmentEmail || '').trim().toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    errors.push('Enrollment email is invalid.');
  }

  return {
    answers,
    errors: [...new Set(errors)],
    onboarding: onboardingAnswers(byKey),
    profile: {
      name: clean(byKey.name, 100),
      email,
      phone: phoneDigits,
      region: clean(byKey.region, 100),
      subregion: clean(byKey.subregion, 100),
    },
  };
}

module.exports = {
  CORE_KEYS,
  fieldId,
  onboardingAnswers,
  portalFieldsFromTemplate,
  validateIntakeSubmission,
};
