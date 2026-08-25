// Private supervisor controls for each cohort's public pre-entry intake link.
const { cohorts } = require('./config');
const {
  getIntakeSettings,
  findSlugOwner,
  portalBaseUrl,
  portalConfigProblems,
  setIntakeSettings,
  slugify,
  validateIntakeBackend,
} = require('./intake-settings');

function usage() {
  return [
    '**Intake portal commands**',
    '`!intake status` — configuration and current link',
    '`!intake enable [slug]` — open this cohort intake',
    '`!intake disable` — close new submissions without deleting data',
    '`!intake link` — show the shareable intake link',
    'The portal uses the current editable enrollment template from `!formtemplate`.',
  ].join('\n');
}

module.exports = function registerIntakeConfig(client) {
  client.on('messageCreate', async message => {
    if (message.author.bot || !message.guildId) return;
    const content = message.content.trim();
    if (!/^!intake(?:\s|$)/i.test(content)) return;
    const cohort = cohorts.find(item => item.guildId === message.guildId);
    if (!cohort || !cohort.supervisorIds.includes(message.author.id)) return;
    if (message.channelId !== cohort.channels.supervisor) {
      await message.reply(`Run this private command in <#${cohort.channels.supervisor}>.`);
      return;
    }
    const rest = content.replace(/^!intake\b/i, '').trim();
    try {
      const settings = await getIntakeSettings(cohort, true);
      const problems = portalConfigProblems();
      if (!rest || /^help$/i.test(rest)) {
        await message.reply({ content: usage(), allowedMentions: { parse: [] } });
        return;
      }
      if (/^status$/i.test(rest)) {
        const link = problems.length
          ? '(portal environment incomplete)'
          : `${portalBaseUrl()}/intake/${settings.slug}`;
        await message.reply({
          content:
            `**Intake portal — ${cohort.name}**\n` +
            `Status: ${settings.enabled ? 'OPEN' : 'CLOSED'}\n` +
            `Link: ${link}\n` +
            `Template: current working enrollment template\n` +
            (problems.length ? `Missing Render settings: ${problems.join(', ')}` : 'Secure OAuth environment: ready'),
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (/^link$/i.test(rest)) {
        if (problems.length) throw new Error(`Portal environment is incomplete: ${problems.join(', ')}`);
        if (!settings.enabled) throw new Error('Intake is closed. Run `!intake enable` first.');
        await message.reply({
          content: `${portalBaseUrl()}/intake/${settings.slug}`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (/^disable$/i.test(rest)) {
        const saved = await setIntakeSettings(cohort, { ...settings, enabled: false });
        await message.reply(`Intake portal closed for **${cohort.name}**. Existing Sheet responses were preserved. Slug: \`${saved.slug}\``);
        return;
      }
      const enable = rest.match(/^enable(?:\s+([a-z0-9-]+))?$/i);
      if (enable) {
        if (problems.length) throw new Error(`Set these Render variables first: ${problems.join(', ')}`);
        const requested = slugify(enable[1] || settings.slug || cohort.registryKey || cohort.name);
        if (!requested) throw new Error('Choose a slug containing letters or numbers, for example `!intake enable stride-2026`.');
        const owner = await findSlugOwner(requested, cohort.guildId);
        if (owner) {
          throw new Error(`The slug \`${requested}\` already belongs to ${owner.cohort.name}. Choose another cohort-specific slug.`);
        }
        await validateIntakeBackend(cohort);
        const saved = await setIntakeSettings(cohort, { enabled: true, slug: requested });
        await message.reply({
          content:
            `Intake portal opened for **${cohort.name}**.\n` +
            `${portalBaseUrl()}/intake/${saved.slug}\n` +
            `OAuth redirect configured in Discord must be: ${portalBaseUrl()}/intake/oauth/callback`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      await message.reply({ content: usage(), allowedMentions: { parse: [] } });
    } catch (error) {
      await message.reply({ content: `Intake command failed: ${error.message.slice(0, 400)}`, allowedMentions: { parse: [] } });
    }
  });
};

module.exports.usage = usage;
