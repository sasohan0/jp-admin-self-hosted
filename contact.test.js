const test = require('node:test');
const assert = require('node:assert/strict');
const { contactMarkdown, phoneDigits, waLink } = require('./contact');

test('normalizes Bangladesh phone numbers for WhatsApp', () => {
  assert.equal(phoneDigits('01712-345678'), '8801712345678');
  assert.equal(phoneDigits('+880 1712 345678'), '8801712345678');
  assert.equal(waLink('1712345678'), 'https://wa.me/8801712345678');
  assert.equal(waLink('1234567890123456789012345'), '');
});

test('renders a private contact line without inventing missing phone data', () => {
  assert.match(contactMarkdown('01712345678'), /WhatsApp/);
  assert.equal(contactMarkdown(''), '_no phone_');
});
