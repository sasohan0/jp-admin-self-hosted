// ============================================================
//  cohort-admin.js - durable, editable Google Form templates
//   !formtemplate ...       -> inspect/edit/save/load templates
//   !createforms <name>     -> build both legacy Google Forms
//   !createforms attendance [name] -> build only the daily attendance Form
//   !designforms <request>  -> AI draft, save, approve, build
// ============================================================
const { cohorts } = require('./config');
const crypto = require('node:crypto');
const { askJson } = require('./groq');
const {
  FORM_KINDS,
  defaultTemplate,
  normalizeKind,
  normalizeTemplate,
  parseFieldDefinition,
  restoreCore,
  sanitizeTemplateName,
  validateTemplate,
} = require('./form-templates');

const pending = new Map(); // approvalMsgId -> { cohort, name, template, expires }

function stateKey(cohort, scope, kind = '') {
  return `formtpl_${cohort.guildId}_${scope}${kind ? `_${kind}` : ''}`;
}

async function parseJsonResponse(res) {
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Backend returned non-JSON (HTTP ${res.status}). Deploy the latest Apps Script Web App version.`); }
  if (!res.ok) throw new Error(`Backend HTTP ${res.status}`);
  if (data.error) throw new Error(data.error);
  return data;
}

async function getState(cohort, key) {
  const url = new URL(cohort.appsScriptUrl);
  url.searchParams.set('action', 'getstate');
  url.searchParams.set('key', cohort.apiKey);
  url.searchParams.set('k', key);
  const res = await fetch(url, { redirect: 'follow' });
  return (await parseJsonResponse(res)).value || '';
}

async function setState(cohort, key, value) {
  const res = await fetch(cohort.appsScriptUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: cohort.apiKey, action: 'setState', k: key, v: value }),
  });
  return parseJsonResponse(res);
}

async function build(cohort, name, template, kinds = ['enrollment', 'attendance']) {
  const res = await fetch(cohort.appsScriptUrl, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: cohort.apiKey, action: 'createForms', cohort: name, spec: template, kinds }),
  });
  return parseJsonResponse(res);
}

async function loadTemplatePair(cohort, scope = 'working', requireExisting = false) {
  const defaults = defaultTemplate();
  const values = await Promise.all(FORM_KINDS.map(kind => getState(cohort, stateKey(cohort, scope, kind))));
  if (requireExisting && values.some(value => !value)) throw new Error('Saved template is incomplete or missing.');
  const input = { version: 1 };
  FORM_KINDS.forEach((kind, index) => {
    if (!values[index]) input[kind] = defaults[kind];
    else {
      try { input[kind] = JSON.parse(values[index]); }
      catch { throw new Error(`Saved ${kind} template is invalid JSON. Reset or load another template.`); }
    }
  });
  return normalizeTemplate(input);
}

async function saveTemplatePair(cohort, template, scope = 'working') {
  const normalized = normalizeTemplate(template);
  for (const kind of FORM_KINDS) {
    for (const field of normalized[kind].fields) {
      if (!field.key && !field.id) field.id = `field_${crypto.randomUUID().replace(/-/g, '')}`;
    }
  }
  for (const kind of FORM_KINDS) {
    const value = JSON.stringify(normalized[kind]);
    if (Buffer.byteLength(value, 'utf8') > 8500) {
      throw new Error(`${kind} template is too large to save. Shorten question/help text or remove choices.`);
    }
    await setState(cohort, stateKey(cohort, scope, kind), value);
  }
  return normalized;
}

async function getManifest(cohort) {
  const raw = await getState(cohort, stateKey(cohort, 'saved_names'));
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { return {}; }
}

async function setManifest(cohort, manifest) {
  await setState(cohort, stateKey(cohort, 'saved_names'), JSON.stringify(manifest));
}

function formatField(field, index) {
  const required = field.required ? 'required' : 'optional';
  const key = field.key ? ` · bot:${field.key}` : '';
  const choices = field.choices?.length ? `\n   ↳ ${field.choices.join(' | ')}${field.other ? ' | Other' : ''}` : '';
  const scale = field.type === 'scale' ? ` · ${field.min || 1}-${field.max || 5}` : '';
  const help = field.help ? `\n   ℹ ${field.help}` : '';
  return `**${index + 1}. ${field.title}**\n   ${field.type}${scale} · ${required}${key}${choices}${help}`;
}

async function sendChunks(channel, heading, blocks) {
  let chunk = `**${heading}**\n`;
  for (const block of blocks) {
    if ((chunk + '\n\n' + block).length > 1900) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      chunk = '';
    }
    chunk += `${chunk ? '\n\n' : ''}${block}`;
  }
  if (chunk) await channel.send({ content: chunk, allowedMentions: { parse: [] } });
}

async function showTemplate(msg, template, kind) {
  const form = template[kind];
  await sendChunks(msg.channel,
    `${kind === 'enrollment' ? 'Enrollment' : 'Attendance'} working template — ${form.fields.length} questions`,
    [
      `Title: ${form.title}\nDescription: ${form.description || '(none)'}\nCollect verified Google email: ${form.collectEmail ? 'yes' : 'no'}`,
      ...form.fields.map(formatField),
    ]);
}

function usage() {
  return [
    '**Form template commands (run in #bot-admin)**',
    '`!formtemplate show enrollment|attendance`',
    '`!formtemplate add <kind> <type> required|optional | Question | Choice 1 | Choice 2 | Other`',
    '`!formtemplate edit <kind> <number> <type> required|optional | Question | choices...`',
    '`!formtemplate remove <kind> <number>` · `move <kind> <from> <to>`',
    '`!formtemplate help <kind> <number> | Help text` (`clear` removes it)',
    '`!formtemplate title|description <kind> | New text`',
    '`!formtemplate collectemail <kind> on|off`',
    '`!formtemplate validate` · `restorecore enrollment|attendance|all`',
    '`!formtemplate save <name>` · `load <name>` · `list` · `delete <name> confirm`',
    '`!formtemplate reset enrollment|attendance|all confirm`',
    'Build: `!createforms attendance [cohort name]` for portal + attendance only; legacy `!createforms <cohort name>` builds both Google Forms.',
    'Types: `text`, `email`, `paragraph`, `choice`, `checkbox`, `scale`, `date`, `time`.',
    'Scale extras: `| 1 | 5 | Poor | Excellent`.',
  ].join('\n');
}

function ensureIndex(form, raw) {
  const index = Number(raw) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= form.fields.length) {
    throw new Error(`Question number must be between 1 and ${form.fields.length}.`);
  }
  return index;
}

async function handleTemplateCommand(msg, cohort, content) {
  const rest = content.replace(/^!formtemplate\b/i, '').trim();
  if (!rest || /^help$/i.test(rest)) {
    await msg.reply({ content: usage(), allowedMentions: { parse: [] } });
    return;
  }

  let match;
  if ((match = rest.match(/^show\s+(enrollment|attendance)$/i))) {
    return showTemplate(msg, await loadTemplatePair(cohort), match[1].toLowerCase());
  }
  if (/^list$/i.test(rest)) {
    const manifest = await getManifest(cohort);
    const names = Object.values(manifest);
    return msg.reply({ content: names.length ? `💾 Saved form templates:\n${names.map(name => `• ${name}`).join('\n')}` : '📭 No named form templates saved yet.', allowedMentions: { parse: [] } });
  }
  if (/^validate$/i.test(rest)) {
    const result = validateTemplate(await loadTemplatePair(cohort));
    return msg.reply({
      content: result.errors.length ? `❌ Template cannot be built yet:\n${result.errors.map(x => `• ${x}`).join('\n')}` : '✅ Working template is valid and contains every bot-required field.',
      allowedMentions: { parse: [] },
    });
  }
  if ((match = rest.match(/^save\s+(.+)$/i))) {
    const displayName = match[1].trim();
    const slug = sanitizeTemplateName(displayName);
    if (!slug) throw new Error('Use a template name containing letters or numbers.');
    const template = await loadTemplatePair(cohort);
    await saveTemplatePair(cohort, template, `saved_${slug}`);
    const manifest = await getManifest(cohort);
    manifest[slug] = displayName.slice(0, 60);
    await setManifest(cohort, manifest);
    return msg.reply({ content: `💾 Saved the current enrollment + attendance pair as **${manifest[slug]}**.`, allowedMentions: { parse: [] } });
  }
  if ((match = rest.match(/^load\s+(.+)$/i))) {
    const slug = sanitizeTemplateName(match[1]);
    const manifest = await getManifest(cohort);
    if (!manifest[slug]) throw new Error('That saved template name was not found. Run `!formtemplate list`.');
    const template = await loadTemplatePair(cohort, `saved_${slug}`, true);
    await saveTemplatePair(cohort, template);
    return msg.reply({ content: `✅ Loaded **${manifest[slug]}** as the working template.`, allowedMentions: { parse: [] } });
  }
  if ((match = rest.match(/^delete\s+(.+?)\s+confirm$/i))) {
    const slug = sanitizeTemplateName(match[1]);
    const manifest = await getManifest(cohort);
    if (!manifest[slug]) throw new Error('That saved template name was not found.');
    await Promise.all(FORM_KINDS.map(kind => setState(cohort, stateKey(cohort, `saved_${slug}`, kind), '')));
    const deleted = manifest[slug];
    delete manifest[slug];
    await setManifest(cohort, manifest);
    return msg.reply({ content: `🗑️ Deleted saved template **${deleted}**.`, allowedMentions: { parse: [] } });
  }
  if ((match = rest.match(/^reset\s+(enrollment|attendance|all)\s+confirm$/i))) {
    const requested = match[1].toLowerCase();
    const defaults = defaultTemplate();
    const working = requested === 'all' ? defaults : await loadTemplatePair(cohort);
    for (const kind of (requested === 'all' ? FORM_KINDS : [requested])) working[kind] = defaults[kind];
    await saveTemplatePair(cohort, working);
    return msg.reply({ content: `♻️ Reset **${requested}** to the built-in bilingual default.`, allowedMentions: { parse: [] } });
  }
  if ((match = rest.match(/^restorecore\s+(enrollment|attendance|all)$/i))) {
    const template = restoreCore(await loadTemplatePair(cohort), match[1].toLowerCase());
    await saveTemplatePair(cohort, template);
    return msg.reply({ content: '✅ Restored any missing bot-required questions at the end of the selected form(s). You may reword or move them.', allowedMentions: { parse: [] } });
  }

  const template = await loadTemplatePair(cohort);
  if ((match = rest.match(/^add\s+(enrollment|attendance)\s+([\s\S]+)$/i))) {
    const kind = match[1].toLowerCase();
    template[kind].fields.push(parseFieldDefinition(match[2]));
    await saveTemplatePair(cohort, template);
    return msg.reply(`✅ Added question ${template[kind].fields.length} to the ${kind} template.`);
  }
  if ((match = rest.match(/^edit\s+(enrollment|attendance)\s+(\d+)\s+([\s\S]+)$/i))) {
    const kind = match[1].toLowerCase();
    const index = ensureIndex(template[kind], match[2]);
    const existing = template[kind].fields[index];
    const replacement = parseFieldDefinition(match[3]);
    if (existing.key) replacement.key = existing.key;
    if (existing.id) replacement.id = existing.id;
    if (existing.help) replacement.help = existing.help;
    template[kind].fields[index] = replacement;
    await saveTemplatePair(cohort, template);
    return msg.reply(`✅ Updated ${kind} question ${index + 1}${existing.key ? ` while preserving bot key \`${existing.key}\`` : ''}.`);
  }
  if ((match = rest.match(/^remove\s+(enrollment|attendance)\s+(\d+)$/i))) {
    const kind = match[1].toLowerCase();
    const index = ensureIndex(template[kind], match[2]);
    const [removed] = template[kind].fields.splice(index, 1);
    await saveTemplatePair(cohort, template);
    const warning = removed.key ? ` ⚠️ It was bot-required (${removed.key}); run \`!formtemplate restorecore ${kind}\` before building.` : '';
    return msg.reply({ content: `🗑️ Removed ${kind} question ${index + 1}.${warning}`, allowedMentions: { parse: [] } });
  }
  if ((match = rest.match(/^move\s+(enrollment|attendance)\s+(\d+)\s+(\d+)$/i))) {
    const kind = match[1].toLowerCase();
    const from = ensureIndex(template[kind], match[2]);
    const toRaw = Number(match[3]) - 1;
    if (!Number.isInteger(toRaw) || toRaw < 0 || toRaw >= template[kind].fields.length) throw new Error(`Destination must be 1-${template[kind].fields.length}.`);
    const [field] = template[kind].fields.splice(from, 1);
    template[kind].fields.splice(toRaw, 0, field);
    await saveTemplatePair(cohort, template);
    return msg.reply(`✅ Moved ${kind} question ${from + 1} to position ${toRaw + 1}.`);
  }
  if ((match = rest.match(/^help\s+(enrollment|attendance)\s+(\d+)\s*\|\s*([\s\S]+)$/i))) {
    const kind = match[1].toLowerCase();
    const index = ensureIndex(template[kind], match[2]);
    const help = match[3].trim();
    if (/^clear$/i.test(help)) delete template[kind].fields[index].help;
    else template[kind].fields[index].help = help;
    await saveTemplatePair(cohort, template);
    return msg.reply(`✅ Updated help text for ${kind} question ${index + 1}.`);
  }
  if ((match = rest.match(/^(title|description)\s+(enrollment|attendance)\s*\|\s*([\s\S]+)$/i))) {
    const property = match[1].toLowerCase();
    const kind = match[2].toLowerCase();
    template[kind][property] = match[3].trim();
    await saveTemplatePair(cohort, template);
    return msg.reply(`✅ Updated the ${kind} form ${property}.`);
  }
  if ((match = rest.match(/^collectemail\s+(enrollment|attendance)\s+(on|off)$/i))) {
    const kind = match[1].toLowerCase();
    template[kind].collectEmail = match[2].toLowerCase() === 'on';
    await saveTemplatePair(cohort, template);
    return msg.reply(`✅ Google verified-email collection is now **${template[kind].collectEmail ? 'on' : 'off'}** for ${kind}.`);
  }

  await msg.reply({ content: `❌ I could not parse that template command.\n\n${usage()}`, allowedMentions: { parse: [] } });
}

function specToText(template) {
  const normalized = normalizeTemplate(template);
  return FORM_KINDS.map(kind => {
    const form = normalized[kind];
    return `**${kind === 'enrollment' ? '📝 Enrollment' : '📅 Daily attendance'}:** ${form.fields.length} questions\n` +
      form.fields.map((field, index) => `${index + 1}. **${field.title}** _(${field.type}${field.required ? ', required' : ''})_`).join('\n');
  }).join('\n\n');
}

module.exports = function registerCohortAdmin(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    const lower = content.toLowerCase();
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (!/^!(formtemplate|createforms|designforms)\b/i.test(content)) return;

    if (cohort.channels?.supervisor && msg.channelId !== cohort.channels.supervisor) {
      await msg.reply({ content: '❌ Form creation and template editing must be done in the private `#bot-admin` channel.', allowedMentions: { parse: [] } });
      return;
    }

    if (lower.startsWith('!formtemplate')) {
      try { await handleTemplateCommand(msg, cohort, content); }
      catch (err) { await msg.reply({ content: `❌ ${err.message}`, allowedMentions: { parse: [] } }); }
      return;
    }

    if (lower.startsWith('!createforms')) {
      const argumentsText = content.slice('!createforms'.length).trim();
      const attendanceOnly = /^attendance(?:\s|$)/i.test(argumentsText);
      const name = (attendanceOnly ? argumentsText.replace(/^attendance\b/i, '').trim() : argumentsText) || cohort.name;
      const kinds = attendanceOnly ? ['attendance'] : ['enrollment', 'attendance'];
      await msg.reply({
        content: attendanceOnly
          ? `🛠 Creating the daily attendance Form for **${name}**. Enrollment will use the intake portal.`
          : `🛠 Creating enrollment + attendance forms for **${name}** from the saved working template...`,
        allowedMentions: { parse: [] },
      });
      try {
        const result = validateTemplate(await loadTemplatePair(cohort));
        if (result.errors.length) throw new Error(`Template cannot be built:\n${result.errors.map(x => `• ${x}`).join('\n')}`);
        const data = await build(cohort, name, result.template, kinds);
        await postResult(msg, name, data);
      } catch (err) {
        await msg.reply({ content: `❌ ${err.message}\nIf this is a backend-version error, deploy the repository's latest Apps Script as a **new Web App version** and authorize Forms access.`, allowedMentions: { parse: [] } });
      }
      return;
    }

    if (lower.startsWith('!designforms')) {
      const desc = content.slice('!designforms'.length).trim();
      if (!desc) return msg.reply('Describe the enrollment and attendance questions you want after `!designforms`.');
      await msg.reply('🤖 Designing an editable form template...');
      try {
        const spec = await askJson([
          { role: 'system', content:
            'Design two Google Forms for an employment bootcamp. Respond ONLY with JSON: ' +
            '{"enrollment":[{"title":"...","type":"text|paragraph|choice|checkbox|scale|date|time","choices":["..."],"required":true,"help":"..."}],"attendance":[...]}. ' +
            'Enrollment MUST include exact concepts: Your Name, enrollment Email, WhatsApp Number, Discord Username, Current Region (Division), Current Subregion / Area, Experience, Currently Job Holder, and Job Focus. ' +
            'Attendance MUST include Date of attendance and Student Email. Keep wording student-friendly and bilingual when requested.' },
          { role: 'user', content: desc },
        ]);
        const template = normalizeTemplate(spec);
        const preview = specToText(template);
        const m = await msg.channel.send({
          embeds: [{
            title: '🧩 Proposed editable forms — react ✅ to save and build',
            description: preview.slice(0, 4000),
            color: 0x9b59b6,
            footer: { text: 'Approval window: 15 minutes. The approved pair becomes the working template.' },
          }],
          allowedMentions: { parse: [] },
        });
        await m.react('✅');
        pending.set(m.id, { cohort, name: cohort.name, template, expires: Date.now() + 15 * 60 * 1000 });
      } catch (err) { await msg.reply({ content: `❌ ${err.message}`, allowedMentions: { parse: [] } }); }
    }
  });

  client.on('messageReactionAdd', async (reaction, user) => {
    try {
      if (reaction.partial) await reaction.fetch();
      const rec = pending.get(reaction.message.id);
      if (!rec || reaction.emoji.name !== '✅') return;
      if (!rec.cohort.supervisorIds.includes(user.id)) return;
      if (Date.now() > rec.expires) { pending.delete(reaction.message.id); return; }
      pending.delete(reaction.message.id);
      const result = validateTemplate(rec.template);
      if (result.errors.length) return reaction.message.reply(`❌ Draft is missing required fields:\n${result.errors.map(x => `• ${x}`).join('\n')}`);
      await saveTemplatePair(rec.cohort, result.template);
      await reaction.message.reply('🛠 Saved as the working template. Building the approved forms...');
      const data = await build(rec.cohort, rec.name, result.template);
      await postResult(reaction.message, rec.name, data);
    } catch (err) { console.error('[cohort-admin] approval failed:', err.message); }
  });
};

async function postResult(msg, name, data) {
  const lines = data.forms.map(form =>
    `**${form.type === 'enrollment' ? '📝 Enrollment' : '📅 Daily Attendance'}**\n` +
    `• Share: ${form.url}\n• Edit: ${form.editUrl}`);
  await msg.channel.send({
    embeds: [{
      title: `✅ Forms created — ${name}`,
      description: lines.join('\n\n'),
      color: 0x2ecc71,
      footer: { text: 'Response tabs added. Attendance auto-linked. Save/share edit links only in supervisor contexts.' },
    }],
    allowedMentions: { parse: [] },
  });
}

module.exports.loadTemplatePair = loadTemplatePair;
module.exports.saveTemplatePair = saveTemplatePair;
