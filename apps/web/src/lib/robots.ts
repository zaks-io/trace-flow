/**
 * robots.txt is assembled by hand instead of through Next's `MetadataRoute.Robots`
 * export: that type only emits Allow/Disallow/Sitemap/Host and has no escape hatch
 * for the `Content-Signal` directive (https://contentsignals.org/).
 */

const SITE_URL = 'https://trace-flow.dev';

const DISALLOWED_PATHS = ['/api', '/app', '/auth', '/invite/', '/waitlist/confirm/'];

/**
 * Trace Flow publishes llms.txt, agents.md, and markdown docs precisely so agents can
 * read and cite them, so `search` and `ai-input` are granted. `ai-train` is withheld:
 * answering with our docs is the point, absorbing them into a training corpus is not.
 */
const CONTENT_SIGNAL = 'ai-train=no, search=yes, ai-input=yes';

export function buildRobotsTxt(): string {
  return [
    '# Content-Signal declares how the content on this site may be used.',
    '# Its syntax and vocabulary come from the IETF AI Preferences (aipref)',
    '# working group draft and carry the meanings set out there.',
    '# See https://contentsignals.org/.',
    '',
    'User-Agent: *',
    `Content-Signal: ${CONTENT_SIGNAL}`,
    'Allow: /',
    ...DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
    '',
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    '',
  ].join('\n');
}
