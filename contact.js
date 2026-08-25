function phoneDigits(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = `880${digits.slice(1)}`;
  else if (!digits.startsWith('880') && digits.length === 10) digits = `880${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

function waLink(phone) {
  const digits = phoneDigits(phone);
  return digits ? `https://wa.me/${digits}` : '';
}

function contactMarkdown(phone) {
  const original = String(phone || '').trim();
  const raw = original.slice(0, 80);
  const wa = waLink(original);
  if (!raw) return '_no phone_';
  return `${raw}${wa ? ` · [WhatsApp](${wa})` : ''}`;
}

module.exports = { contactMarkdown, phoneDigits, waLink };
