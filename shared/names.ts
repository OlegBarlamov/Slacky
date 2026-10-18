// Channel naming, shared so the client can preview exactly what the server will accept.
// Slack-style: lowercase, spaces become hyphens, letters/digits/hyphens/underscores only.

export const CHANNEL_NAME_MAX = 80;
export const CHANNEL_NAME_RULES = `Lowercase letters, numbers, hyphens and underscores, up to ${CHANNEL_NAME_MAX} characters. Spaces become hyphens.`;

export const toChannelName = (raw: string) => raw.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');

export const isValidChannelName = (name: string) => name.length <= CHANNEL_NAME_MAX && /^[a-z0-9][a-z0-9_-]*$/.test(name);
