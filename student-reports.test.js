const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attentionReasons, filterStudentsNeedingAttention, metricLine, reportPanel,
} = require('./student-reports');

test('private metric line includes a WhatsApp contact and all requested metrics', () => {
  const line = metricLine({
    name: 'Student', jobs: 10, attendance: 4, interviews: 2,
    outreach: 3, communicationPractices: 1, workshops: 2, phone: '01700000000',
  }, 1);
  assert.match(line, /Apps 10/);
  assert.match(line, /Attendance 4/);
  assert.match(line, /wa\.me\/8801700000000/);
});

test('student report panel offers one, all, and needs-attention choices', () => {
  const panel = reportPanel();
  const ids = panel.components.flatMap(row => row.components.map(component => component.data.custom_id));
  assert.deepEqual(ids, ['student_report_one', 'student_report_all', 'student_report_attention']);
});

test('needs-attention excludes students who are merely a little below the full weekly target', () => {
  const students = filterStudentsNeedingAttention([
    { name: 'Healthy', jobs: 60, attendance: 4 },
    { name: 'Low applications', jobs: 20, attendance: 4 },
    { name: 'No attendance', jobs: 75, attendance: 0 },
  ], { applications: 75, attendance: 5 });
  assert.deepEqual(students.map(student => student.name), ['Low applications', 'No attendance']);
  assert.match(students[0].attentionReasons[0], /below 50%/);
});

test('attention reasons are explicit for zero activity', () => {
  assert.deepEqual(attentionReasons({ jobs: 0, attendance: 0 }, { applications: 50, attendance: 5 }), [
    'no applications recorded',
    'no attendance recorded',
  ]);
});

test('private metric line displays configured progress targets', () => {
  const line = metricLine({ name: 'Student', jobs: 20, attendance: 2 }, 1, { applications: 50, attendance: 5 });
  assert.match(line, /Apps 20\/50/);
  assert.match(line, /Attendance 2\/5/);
});
