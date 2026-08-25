const test = require('node:test');
const assert = require('node:assert/strict');

const {
  onboardingAnswers,
  portalFieldsFromTemplate,
  validateIntakeSubmission,
} = require('./intake-schema');
const { defaultTemplate } = require('./form-templates');

test('private placement answers map to the existing onboarding role vocabulary', () => {
  assert.deepEqual(onboardingAnswers({
    genderPreference: 'Prefer not to say', region: 'Abroad',
    availability: 'Searching, but limited availability',
    studyStage: 'University 1st–3rd year',
  }), {
    gender: 'private', division: 'Abroad', availability: 'limited', studyStage: 'university_early',
  });
});

function template() {
  return { enrollment: { fields: [
    { key: 'name', title: 'Full name', type: 'text', required: true },
    { key: 'enrollmentEmail', title: 'Enrollment email', type: 'email', required: true },
    { key: 'phone', title: 'Phone', type: 'text', required: true },
    { key: 'region', title: 'Division', type: 'choice', required: true, choices: ['Dhaka', 'Abroad'], other: true },
    { key: 'subregion', title: 'District / area', type: 'text', required: true },
    { key: 'technologies', title: 'Technologies', type: 'checkbox', required: true, choices: ['React', 'Node'], other: true },
    { key: 'rulesCommitment', title: 'Rules commitment', type: 'choice', required: true, choices: ['Yes', 'Need help'] },
    { key: 'discordUsername', title: 'Discord username', type: 'text', required: true },
    { title: 'Why do you need a job?', type: 'paragraph', required: true },
  ] } };
}

test('portal reuses the editable enrollment template and captures Discord identity automatically', () => {
  const fields = portalFieldsFromTemplate(template());
  assert.equal(fields.some(field => field.key === 'discordUsername'), false);
  assert.equal(fields.some(field => field.key === 'rulesCommitment'), true);
  assert.equal(fields.find(field => field.key === 'name').title, 'Full name');
  assert.match(fields.find(field => !field.key).id, /^q_9_/);
});

test('default portal preserves every non-Discord STRIDE field and its own rules commitment', () => {
  const fields = portalFieldsFromTemplate(defaultTemplate());
  const keys = new Set(fields.map(field => field.key).filter(Boolean));
  const expected = [
    'name', 'enrollmentEmail', 'phone', 'region', 'subregion', 'jobFocus',
    'onsiteAreas', 'remoteReason', 'education', 'englishCommunication',
    'experience', 'jobHolder', 'nextExam', 'jobMotivation', 'resume',
    'linkedin', 'linkedinRestricted', 'github', 'portfolio', 'bestProject',
    'technologies', 'positions', 'freeTimeSlots', 'jobSeriousness',
    'specialReferral', 'comments', 'genderPreference', 'studyStage',
    'availability', 'rulesCommitment',
  ];
  for (const key of expected) assert.ok(keys.has(key), `portal lost intake field ${key}`);
  assert.equal(keys.has('discordUsername'), false, 'OAuth supplies the Discord username');
  assert.doesNotMatch(JSON.stringify(fields), /[\u0980-\u09ff]/, 'portal defaults must be English-only');
});

test('custom question IDs survive title edits and keep one structured Sheet column', () => {
  const first = portalFieldsFromTemplate({ enrollment: { fields: [
    { id: 'field_abc123', title: 'Old wording', type: 'text' },
  ] } })[0];
  const edited = portalFieldsFromTemplate({ enrollment: { fields: [
    { id: 'field_abc123', title: 'Improved wording', type: 'paragraph' },
  ] } })[0];
  assert.equal(first.id, 'field_abc123');
  assert.equal(edited.id, first.id);
});

test('intake validation returns structured answers and canonical tracking identity', () => {
  const fields = portalFieldsFromTemplate(template());
  const params = new URLSearchParams();
  params.set('name', 'Sajeda Begum');
  params.set('enrollmentemail', 'SAJEDA@example.com');
  params.set('phone', '+8801712345678');
  params.set('region', 'Dhaka');
  params.set('subregion', 'Mirpur');
  params.append('technologies', 'React');
  params.append('technologies', 'Node');
  params.set('rulescommitment', 'Yes');
  params.set(fields.find(field => !field.key).id, 'I am ready for full-time work.');
  const result = validateIntakeSubmission(fields, params);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.profile, {
    name: 'Sajeda Begum',
    email: 'sajeda@example.com',
    phone: '8801712345678',
    region: 'Dhaka',
    subregion: 'Mirpur',
  });
  assert.deepEqual(result.onboarding, {
    gender: '', division: 'Dhaka', availability: '', studyStage: '',
  });
  assert.equal(result.answers.find(answer => answer.semanticKey === 'technologies').value, 'React, Node');
});

test('intake validation rejects incomplete core identity and unrecognized choices', () => {
  const fields = portalFieldsFromTemplate(template());
  const params = new URLSearchParams({ name: 'X', region: 'Unknown' });
  const result = validateIntakeSubmission(fields, params);
  assert.ok(result.errors.some(error => /Enrollment email is required/.test(error)));
  assert.ok(result.errors.some(error => /Division is required/.test(error)));
});
