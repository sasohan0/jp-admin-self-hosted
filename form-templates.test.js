const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_KEYS,
  defaultTemplate,
  normalizeTemplate,
  parseFieldDefinition,
  restoreCore,
  sanitizeTemplateName,
  validateTemplate,
} = require('./form-templates');

test('English defaults preserve the placement fields, bot keys, checkbox, and time support', () => {
  const result = validateTemplate(defaultTemplate());
  assert.deepEqual(result.errors, []);
  assert.equal(result.template.enrollment.fields.length, 31);
  assert.equal(result.template.attendance.fields.length, 11);
  assert.doesNotMatch(JSON.stringify(result.template), /[\u0980-\u09ff]/, 'default student forms must be English-only');
  for (const kind of ['enrollment', 'attendance']) {
    const keys = new Set(result.template[kind].fields.map(field => field.key).filter(Boolean));
    for (const key of REQUIRED_KEYS[kind]) assert.ok(keys.has(key), `${kind} missing ${key}`);
  }
  assert.ok(result.template.enrollment.fields.some(field => field.type === 'checkbox' && field.other));
  for (const key of ['genderPreference', 'studyStage', 'availability']) {
    assert.ok(result.template.enrollment.fields.some(field => field.key === key), `enrollment missing ${key}`);
  }
  const originalGoogleFormKeys = [
    'name', 'enrollmentEmail', 'phone', 'region', 'subregion', 'jobFocus', 'onsiteAreas', 'remoteReason',
    'education', 'englishCommunication', 'experience', 'nextExam', 'jobMotivation',
    'resume', 'linkedin', 'linkedinRestricted', 'github', 'portfolio', 'bestProject',
    'technologies', 'positions', 'freeTimeSlots', 'jobSeriousness', 'specialReferral',
    'rulesCommitment', 'discordUsername', 'comments',
  ];
  const enrollmentKeys = new Set(result.template.enrollment.fields.map(field => field.key));
  for (const key of originalGoogleFormKeys) {
    assert.ok(enrollmentKeys.has(key), `default enrollment template lost Google Form field ${key}`);
  }
  assert.ok(result.template.attendance.fields.some(field => field.type === 'time'));
  assert.equal(result.template.attendance.fields.find(field => field.key === 'studentEmail').type, 'email');
});

test('supervisor field syntax parses choices, Other, and scale labels', () => {
  assert.deepEqual(
    parseFieldDefinition('checkbox required | Technologies? | React | Node.js | Other'),
    { title: 'Technologies?', type: 'checkbox', required: true, choices: ['React', 'Node.js'], other: true },
  );
  assert.deepEqual(
    parseFieldDefinition('scale optional | Confidence | 1 | 10 | Low | High'),
    { title: 'Confidence', type: 'scale', required: false, min: 1, max: 10, lowLabel: 'Low', highLabel: 'High' },
  );
});

test('legacy AI arrays infer required semantic keys without duplicate guesses', () => {
  const template = normalizeTemplate({
    enrollment: [
      { title: 'Your Name', type: 'text' },
      { title: 'Job Focus', type: 'choice', choices: ['Remote'] },
      { title: 'Why are you remote job focused?', type: 'paragraph' },
      { title: 'Current Region (Division)', type: 'text' },
      { title: 'Current Subregion / Area', type: 'text' },
    ],
    attendance: [
      { title: 'Date of attendance', type: 'date' },
      { title: 'Student Email', type: 'text' },
    ],
  });
  assert.equal(template.enrollment.fields[0].key, 'name');
  assert.equal(template.enrollment.fields[1].key, 'jobFocus');
  assert.equal(template.enrollment.fields[2].key, undefined);
  assert.equal(template.enrollment.fields[3].key, 'region');
  assert.equal(template.enrollment.fields[4].key, 'subregion');
  assert.equal(template.attendance.fields[0].key, 'attendanceDate');
});

test('removing a core question blocks building until restorecore repairs it', () => {
  const template = defaultTemplate();
  template.attendance.fields = template.attendance.fields.filter(field => field.key !== 'studentEmail');
  assert.match(validateTemplate(template).errors.join('\n'), /missing bot-required questions \(studentEmail\)/);
  const repaired = restoreCore(template, 'attendance');
  assert.deepEqual(validateTemplate(repaired).errors, []);
});

test('invalid Google Forms scale bounds are rejected before creation', () => {
  const template = defaultTemplate();
  template.attendance.fields.find(field => field.key === 'mood').max = 20;
  assert.match(validateTemplate(template).errors.join('\n'), /scale must use minimum 0 or 1 and maximum 3-10/);
});

test('named template slugs are bounded and safe for state keys', () => {
  assert.equal(sanitizeTemplateName(' EJP 13 / Placement Default '), 'ejp-13-placement-default');
  assert.equal(sanitizeTemplateName('বাংলা'), '');
});
