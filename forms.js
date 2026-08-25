// ============================================================
//  forms.js - !forms : list all forms bound to the sheet and
//  switch which one !openform/!closeform/attendance controls.
//   !forms                 -> numbered list (★ = active)
//   !forms use <number|id>  -> set active attendance form
// ============================================================
const { cohorts } = require('./config');

async function api(cohort, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${cohort.appsScriptUrl}?key=${encodeURIComponent(cohort.apiKey)}&${qs}`, { redirect: 'follow' });
  return res.json();
}

function isFormsCommand(content) {
  return /^!forms(?:\s|$)/i.test(String(content || '').trim());
}

module.exports = function registerForms(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    if (!isFormsCommand(content)) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    const parts = content.split(/\s+/);
    try {
      const data = await api(cohort, { action: 'listforms' });
      const forms = data.forms || [];

      // !forms link <formId | edit URL> - register any form as active
      if (parts[1] && parts[1].toLowerCase() === 'link') {
        const raw = parts.slice(2).join(' ');
        let formId = raw.trim();
        const m = raw.match(/forms\/d\/(?!e\/)([\w-]{20,})/);
        if (m) formId = m[1];
        if (/forms\/d\/e\//.test(raw)) {
          return msg.reply('⚠️ That is a *published* link — I need the **edit** link (docs.google.com/forms/d/FORM_ID/edit) or the raw form ID.');
        }
        if (!/^[\w-]{20,}$/.test(formId)) return msg.reply('Usage: `!forms link <form edit URL or form ID>`');
        const r = await api(cohort, { action: 'setactiveform', formId });
        if (r.error) throw new Error(r.error);
        return msg.reply(`✅ Linked and activated: **${r.title}** — \`!openform\`/\`!closeform\` now control it.`);
      }

      if (!forms.length) return msg.reply('📭 No forms bound to this sheet yet. Create some with `!designforms`/`!createforms`, or link an existing attendance form with `!forms link <edit URL or form ID>`.');

      // !forms use <n|id>
      if (parts[1] && parts[1].toLowerCase() === 'use') {
        const sel = parts[2];
        let formId = sel;
        const asNum = parseInt(sel, 10);
        if (!isNaN(asNum) && forms[asNum - 1]) formId = forms[asNum - 1].id;
        const r = await api(cohort, { action: 'setactiveform', formId });
        if (r.error) throw new Error(r.error);
        return msg.reply(`✅ \`!openform\`/\`!closeform\`/\`!attendance\` now control **${r.title}**.`);
      }

      // list
      const lines = forms.map((f, i) =>
        `**${i + 1}.** ${f.isActive ? '⭐ ' : ''}**${f.title}**\n↳ ${f.publishedUrl}`);
      await msg.channel.send({
        embeds: [{
          title: `📋 Forms bound to this sheet (${forms.length})`,
          description: lines.join('\n\n').slice(0, 4000),
          color: 0x3498db,
          footer: { text: '⭐ = active (controlled by !openform/!closeform). Switch: !forms use <number>' },
        }],
      });
    } catch (err) { await msg.reply('❌ ' + err.message); }
  });
};

module.exports.isFormsCommand = isFormsCommand;
