export const DEFAULT_PROMPT = `You are a perceptive music curator. Choose exactly one real song that fits the emotional tone, setting, pace, and subtext of the supplied conversation excerpt.

Preserve nuance: do not reduce a complex scene to one obvious emotion. Prefer a specific, thoughtful match over a generic chart hit, and vary genres, eras, languages, and regions when appropriate. Do not invent a song or artist. Return only the requested title and artist fields.`;

export const DEFAULT_SETTINGS = Object.freeze({
    version: 3,
    enabled: true,
    autoSuggest: true,
    onlyWhenIdle: true,
    historyMessages: 8,
    cooldownMinutes: 3,
    pollIntervalSeconds: 15,
    prompt: DEFAULT_PROMPT,
});

function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function normalizeSettings(input = {}) {
    return {
        version: 3,
        enabled: input.enabled ?? DEFAULT_SETTINGS.enabled,
        autoSuggest: input.autoSuggest ?? DEFAULT_SETTINGS.autoSuggest,
        onlyWhenIdle: input.onlyWhenIdle ?? DEFAULT_SETTINGS.onlyWhenIdle,
        historyMessages: Math.round(clampNumber(input.historyMessages, DEFAULT_SETTINGS.historyMessages, 2, 30)),
        cooldownMinutes: clampNumber(input.cooldownMinutes, DEFAULT_SETTINGS.cooldownMinutes, 0, 120),
        pollIntervalSeconds: Math.round(clampNumber(input.pollIntervalSeconds, DEFAULT_SETTINGS.pollIntervalSeconds, 10, 120)),
        prompt: typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.trim() : DEFAULT_SETTINGS.prompt,
    };
}

export function buildChatExcerpt(chat, historyMessages = DEFAULT_SETTINGS.historyMessages) {
    if (!Array.isArray(chat)) return '';
    return chat
        .filter(message => message && !message.is_system && typeof message.mes === 'string' && message.mes.trim())
        .slice(-historyMessages)
        .map(message => {
            const role = message.is_user ? 'User' : (message.name || 'Assistant');
            const text = message.mes.replace(/\s+/g, ' ').trim();
            return `${role}: ${text}`;
        })
        .join('\n');
}

function cleanField(value) {
    return typeof value === 'string'
        ? value.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)
        : '';
}

export function parseMusicSuggestion(value) {
    if (!value) return null;
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch {
            const title = value.match(/(?:^|\n)\s*Title\s*:\s*(.+)/i)?.[1];
            const artist = value.match(/(?:^|\n)\s*Artist\s*:\s*(.+)/i)?.[1];
            parsed = { title, artist };
        }
    }
    const title = cleanField(parsed?.title);
    const artist = cleanField(parsed?.artist);
    return title && artist ? { title, artist } : null;
}

export function shouldAnalyze({
    manual = false,
    autoSuggest,
    excerpt,
    signature,
    lastAnalyzedSignature,
    lastSuggestionAt,
    cooldownMinutes,
    now = Date.now(),
}) {
    if (!excerpt) return { allowed: false, reason: 'There is no conversation to analyze yet.' };
    if (manual) return { allowed: true };
    if (!autoSuggest) return { allowed: false, reason: 'Automatic suggestions are disabled.' };
    if (signature === lastAnalyzedSignature) return { allowed: false, reason: 'This conversation state was already analyzed.' };
    if (now - lastSuggestionAt < cooldownMinutes * 60_000) {
        return { allowed: false, reason: 'The suggestion cooldown is still active.' };
    }
    return { allowed: true };
}
