export class SpotifyApiError extends Error {
    constructor(status, message, details = {}) {
        super(message);
        this.name = 'SpotifyApiError';
        this.status = status;
        this.details = details;
    }
}

export function cleanCredential(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

export function validateSuggestion(input) {
    const title = cleanCredential(input?.title);
    const artist = cleanCredential(input?.artist);
    if (!title || !artist || title.length > 200 || artist.length > 200) {
        throw new SpotifyApiError(400, 'A song title and artist are required.');
    }
    return { title, artist };
}

export function normalizeSpotifyError(status, body, retryAfter) {
    const spotifyMessage = body?.error?.message || body?.error_description || body?.message;
    const messages = {
        400: spotifyMessage || 'Spotify rejected the request.',
        401: 'Spotify authorization expired. Log in again.',
        403: spotifyMessage || 'Spotify denied this action. Confirm Premium access and the app user allowlist.',
        404: spotifyMessage || 'Spotify could not find an active playback target.',
        429: `Spotify rate limit reached.${retryAfter ? ` Try again in ${retryAfter} seconds.` : ''}`,
    };
    return {
        status: status >= 400 && status < 600 ? status : 502,
        message: messages[status] || spotifyMessage || 'Spotify returned an unexpected error.',
        retryAfter: retryAfter || null,
    };
}
