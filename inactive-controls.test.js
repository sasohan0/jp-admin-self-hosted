'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  UNKNOWN_DATE,
  activeRecords,
  buildActivePanel,
  buildInactivePanel,
  buildStatusOverview,
  dateGroups,
  inactiveRecords,
  parseInactiveStudentsCommand,
  parseStudentPanelCommand,
} = require('./inactive-controls');

test('inactive-student command opens a one-based paginated control panel', () => {
  assert.deepEqual(parseInactiveStudentsCommand('!inactivestudents'), { page: 0 });
  assert.deepEqual(parseInactiveStudentsCommand('!inactivepanel page 3'), { page: 2 });
  assert.equal(parseInactiveStudentsCommand('!inactive 7'), null);
});

test('student status center provides overview and separate active list commands', () => {
  assert.deepEqual(parseStudentPanelCommand('!studentstatuspanel'), { view: 'overview', page: 0 });
  assert.deepEqual(parseStudentPanelCommand('!activestudents page 2'), { view: 'active', page: 1 });
  assert.equal(parseStudentPanelCommand('!studentstatus @user active'), null);
});

test('active records exclude inactive and protected students', () => {
  const active = activeRecords([
    { discordId: '1', name: 'Active', active: true, status: '' },
    { discordId: '2', name: 'Manual', active: true, status: '' },
    { discordId: '3', name: 'Colored', active: false, status: '' },
    { discordId: '4', name: 'Hired', active: true, status: 'hired' },
  ], new Set(['2']));
  assert.deepEqual(active.map(item => item.discordId), ['1']);
});

test('inactive records include durable or warning dates and protect hired students', () => {
  const roster = [
    { discordId: '101', name: 'Manual', active: true, status: '' },
    { discordId: '102', name: 'Warning', active: false, status: '', inactiveReasons: ['Attendance color'] },
    { discordId: '103', name: 'Legacy Color', active: false, status: '' },
    { discordId: '104', name: 'Hired', active: false, status: 'hired' },
    { discordId: '105', name: 'Active', active: true, status: '' },
  ];
  const records = inactiveRecords(roster, new Set(['101', '104']), {
    102: { count: 3, inactive: true, updatedAt: '2026-08-16T20:00:00.000Z' },
  }, {
    101: { inactiveDate: '2026-08-15', source: 'manual', reason: 'Mentor decision' },
  }, 'Asia/Dhaka');
  assert.deepEqual(records.map(item => item.discordId), ['102', '101', '103']);
  assert.equal(records[0].inactiveDate, '2026-08-17');
  assert.equal(records[0].warningCount, 3);
  assert.equal(records[1].inactiveDate, '2026-08-15');
  assert.equal(records[2].inactiveDate, '');
});

test('status overview and active list expose mobile-safe navigation and controls', () => {
  const cohort = { name: 'SCPC-13', guildId: '1534781682920456192' };
  const records = Array.from({ length: 6 }, (_, index) => ({
    discordId: String(100000000000000000n + BigInt(index)),
    name: `Student ${index + 1}`, email: `s${index}@example.com`, phone: '0123',
  }));
  const activePanel = buildActivePanel(cohort, records, 0);
  const overview = buildStatusOverview(cohort, {
    active: records, inactive: [{ discordId: '9' }], protectedCount: 2,
  });
  assert.equal(activePanel.components.length, 5);
  assert.match(activePanel.embeds[0].data.footer.text, /6 active/);
  assert.match(overview.embeds[0].data.description, /Active students: 6/);
  assert.equal(overview.components[0].components.length, 3);
});

test('inactive date groups support exact dates and a visible legacy bucket', () => {
  const groups = dateGroups([
    { inactiveDate: '2026-08-16' },
    { inactiveDate: '2026-08-16' },
    { inactiveDate: '2026-08-15' },
    { inactiveDate: '' },
  ]);
  assert.deepEqual(groups.map(([date, students]) => [date, students.length]), [
    ['2026-08-16', 2],
    ['2026-08-15', 1],
    [UNKNOWN_DATE, 1],
  ]);
});

test('inactive panel stays within Discord five-row component limit', () => {
  const cohort = { name: 'SCPC-13', guildId: '1534781682920456192' };
  const records = Array.from({ length: 9 }, (_, index) => ({
    discordId: String(100000000000000000n + BigInt(index)),
    name: `Student ${index + 1}`,
    inactiveDate: '2026-08-17',
    warningCount: index % 3,
    reason: 'Test reason',
    source: 'manual',
  }));
  const panel = buildInactivePanel(cohort, records, 1);
  assert.equal(panel.components.length, 5);
  assert.match(panel.embeds[0].data.footer.text, /page 2\/3/);
  assert.ok(panel.components.every(row => row.components.length <= 5));
  assert.match(panel.components[0].components[1].data.custom_id, /inactive:emailone:/);
  assert.match(panel.components[4].components[4].data.custom_id, /inactive:emailall:/);
});
