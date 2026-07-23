import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
    SpotifyApiError,
    cleanCredential,
    escapeHtml,
    normalizeSpotifyError,
    validateSuggestion,
} from './lib.mjs';

const VERSION = '3.0.0';
const AUTHORIZATION_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';
const SCOPES = 'user-read-playback-state user-modify-playback-state';
const REQUEST_TIMEOUT_MS = 12_000;
const AUTH_STATE_TTL_MS = 10 * 60_000;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const LOG_PREFIX = '[Mood Music Plugin]';

let clientId = cleanCredential(process.env.MOODMUSIC_SPOTIFY_CLIENT_ID);
let clientSecret = cleanCredential(process.env.MOODMUSIC_SPOTIFY_CLIENT_SECRET);
let accessToken = null;
let refreshToken = null;
let accessTokenExpiresAt = 0;
let refreshPromise = null;
const pendingAuthStates = new Map();

function credentialsSet() {
    return Boolean(clientId && clientSecret);
}

function credentialsManagedByEnvironment() {
    return Boolean(
        cleanCredential(process.env.MOODMUSIC_SPOTIFY_CLIENT_ID)
        && cleanCredential(process.env.MOODMUSIC_SPOTIFY_CLIENT_SECRET),
    );
}

function getRedirectUri(req) {
    const configured = cleanCredential(process.env.MOODMUSIC_SPOTIFY_REDIRECT_URI);
    if (configured) return configured;
    const origin = new URL(`${req.protocol}://${req.get('host')}`);
    if (origin.hostname === 'localhost') origin.hostname = '127.0.0.1';
    return `${origin.origin}/api/plugins/moodmusic/auth/callback`;
}

function clearTokens() {
    accessToken = null;
    refreshToken = null;
    accessTokenExpiresAt = 0;
    refreshPromise = null;
}

function pruneAuthStates() {
    const now = Date.now();
    for (const [state, expiresAt] of pendingAuthStates) {
        if (expiresAt <= now) pendingAuthStates.delete(state);
    }
}

function createAuthState() {
    pruneAuthStates();
    const state = randomBytes(32).toString('base64url');
    pendingAuthStates.set(state, Date.now() + AUTH_STATE_TTL_MS);
    return state;
}

function consumeAuthState(candidate) {
    if (typeof candidate !== 'string') return false;
    pruneAuthStates();
    const match = [...pendingAuthStates.keys()].find(state => {
        const left = Buffer.from(state);
        const right = Buffer.from(candidate);
        return left.length === right.length && timingSafeEqual(left, right);
    });
    if (!match) return false;
    pendingAuthStates.delete(match);
    return true;
}

function sendAuthPage(res, title, message, success) {
    const safeTitle = escapeHtml(title);
    const safeMessage = escapeHtml(message);
    res.status(success ? 200 : 400)
        .type('html')
        .set('Cache-Control', 'no-store')
        .send(`<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${safeTitle}</title>
    <style>
        :root { color-scheme: dark; font-family: system-ui, sans-serif; }
        body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #121212; color: #f5f5f5; }
        main { max-width: 34rem; padding: 2rem; text-align: center; border: 1px solid #444; border-radius: 1rem; background: #242424; }
        h1 { color: ${success ? '#1ed760' : '#ff6b6b'}; }
        button { padding: .7rem 1rem; border: 0; border-radius: .5rem; cursor: pointer; }
    </style>
</head>
<body>
    <main>
        <h1>${safeTitle}</h1>
        <p>${safeMessage}</p>
        <button type="button" onclick="window.close()">Close</button>
    </main>
    <script>if (window.opener) window.opener.postMessage({ type: 'moodmusic-auth', success: ${success} }, window.location.origin);</script>
</body>
</html>`);
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new SpotifyApiError(504, 'Spotify did not respond in time.');
        }
        throw new SpotifyApiError(502, 'Could not reach Spotify.');
    } finally {
        clearTimeout(timer);
    }
}

async function readResponse(response) {
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return { message: text };
    }
}

async function spotifyRequest(path, { method = 'GET', body, token, query } = {}) {
    const url = new URL(path.startsWith('http') ? path : `${API_URL}${path}`);
    if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
    }
    const response = await fetchWithTimeout(url, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await readResponse(response);
    if (!response.ok) {
        const normalized = normalizeSpotifyError(response.status, data, response.headers.get('retry-after'));
        throw new SpotifyApiError(normalized.status, normalized.message, normalized);
    }
    return data;
}

async function exchangeToken(form) {
    const response = await fetchWithTimeout(TOKEN_URL, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form),
    });
    const data = await readResponse(response);
    if (!response.ok) {
        const normalized = normalizeSpotifyError(response.status, data, response.headers.get('retry-after'));
        throw new SpotifyApiError(normalized.status, normalized.message, normalized);
    }
    return data;
}

function storeTokens(data) {
    if (!data?.access_token) throw new SpotifyApiError(502, 'Spotify did not return an access token.');
    accessToken = data.access_token;
    if (data.refresh_token) refreshToken = data.refresh_token;
    accessTokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1_000;
}

async function getValidAccessToken() {
    if (!credentialsSet()) throw new SpotifyApiError(400, 'Spotify credentials are not configured.');
    if (accessToken && Date.now() < accessTokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS) return accessToken;
    if (!refreshToken) throw new SpotifyApiError(401, 'Spotify login is required.');

    if (!refreshPromise) {
        refreshPromise = exchangeToken({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        }).then(data => {
            storeTokens(data);
            return accessToken;
        }).catch(error => {
            clearTokens();
            throw error;
        }).finally(() => {
            refreshPromise = null;
        });
    }
    return refreshPromise;
}

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sendError(error, res) {
    const status = error instanceof SpotifyApiError ? error.status : 500;
    if (status >= 500) console.error(`${LOG_PREFIX} Request failed:`, error);
    const payload = {
        success: false,
        message: error instanceof SpotifyApiError ? error.message : 'An internal Mood Music error occurred.',
        ...(status === 401 ? { needsLogin: true } : {}),
        ...(status === 400 && !credentialsSet() ? { needsConfiguration: true } : {}),
        ...(error.details?.retryAfter ? { retryAfter: error.details.retryAfter } : {}),
    };
    res.status(status).json(payload);
}

export async function init(router) {
    router.use((_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    router.get('/health', (_req, res) => {
        res.json({ ok: true, id: info.id, version: VERSION });
    });

    router.get('/config', (req, res) => {
        res.json({
            clientIdSet: Boolean(clientId),
            clientSecretSet: Boolean(clientSecret),
            credentialsSet: credentialsSet(),
            managedByEnvironment: credentialsManagedByEnvironment(),
            redirectUri: getRedirectUri(req),
        });
    });

    router.post('/config', (req, res) => {
        if (credentialsManagedByEnvironment()) {
            return res.status(409).json({
                success: false,
                message: 'Spotify credentials are managed by server environment variables.',
            });
        }
        const nextClientId = cleanCredential(req.body?.clientId);
        const nextClientSecret = cleanCredential(req.body?.clientSecret);
        if (!nextClientId || !nextClientSecret || nextClientId.length > 256 || nextClientSecret.length > 512) {
            return res.status(400).json({
                success: false,
                message: 'A valid Spotify client ID and client secret are required.',
            });
        }
        clientId = nextClientId;
        clientSecret = nextClientSecret;
        clearTokens();
        res.json({ success: true, message: 'Spotify credentials updated. Log in again to continue.' });
    });

    router.get('/auth/login', (req, res) => {
        if (!credentialsSet()) {
            return sendAuthPage(res, 'Setup required', 'Configure Spotify credentials before logging in.', false);
        }
        const url = new URL(AUTHORIZATION_URL);
        url.search = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            scope: SCOPES,
            redirect_uri: getRedirectUri(req),
            state: createAuthState(),
            show_dialog: 'true',
        }).toString();
        res.redirect(url.toString());
    });

    router.get('/auth/callback', asyncRoute(async (req, res) => {
        if (req.query.error) {
            return sendAuthPage(res, 'Spotify login cancelled', String(req.query.error), false);
        }
        if (!consumeAuthState(req.query.state)) {
            return sendAuthPage(res, 'Spotify login failed', 'The authorization state was missing, expired, or invalid.', false);
        }
        if (typeof req.query.code !== 'string' || !req.query.code) {
            return sendAuthPage(res, 'Spotify login failed', 'Spotify did not return an authorization code.', false);
        }
        try {
            const tokens = await exchangeToken({
                grant_type: 'authorization_code',
                code: req.query.code,
                redirect_uri: getRedirectUri(req),
            });
            storeTokens(tokens);
            return sendAuthPage(res, 'Spotify connected', 'Mood Music can now control playback.', true);
        } catch (error) {
            console.error(`${LOG_PREFIX} OAuth callback failed:`, error);
            return sendAuthPage(res, 'Spotify login failed', error.message, false);
        }
    }));

    router.get('/auth/status', (_req, res) => {
        res.json({
            loggedIn: Boolean(refreshToken),
            credentialsSet: credentialsSet(),
            tokenActive: Boolean(accessToken && Date.now() < accessTokenExpiresAt),
        });
    });

    router.post('/auth/logout', (_req, res) => {
        clearTokens();
        pendingAuthStates.clear();
        res.json({ success: true, message: 'Spotify disconnected.' });
    });

    router.get('/playback/state', asyncRoute(async (_req, res) => {
        const token = await getValidAccessToken();
        const state = await spotifyRequest('/me/player', { token });
        if (!state) return res.json({ isPlaying: false, item: null, device: null });
        res.json({
            isPlaying: Boolean(state.is_playing),
            progressMs: state.progress_ms ?? null,
            item: state.item ? {
                uri: state.item.uri,
                name: state.item.name,
                artists: state.item.artists?.map(artist => artist.name) ?? [],
                durationMs: state.item.duration_ms,
            } : null,
            device: state.device ? {
                id: state.device.id,
                name: state.device.name,
                type: state.device.type,
                active: Boolean(state.device.is_active),
            } : null,
        });
    }));

    router.get('/devices', asyncRoute(async (_req, res) => {
        const token = await getValidAccessToken();
        const data = await spotifyRequest('/me/player/devices', { token });
        res.json({
            devices: (data?.devices ?? []).map(device => ({
                id: device.id,
                name: device.name,
                type: device.type,
                active: Boolean(device.is_active),
                restricted: Boolean(device.is_restricted),
            })),
        });
    }));

    router.post('/play', asyncRoute(async (req, res) => {
        const suggestion = validateSuggestion(req.body?.suggestion);
        const token = await getValidAccessToken();
        const query = `track:${suggestion.title} artist:${suggestion.artist}`;
        let search = await spotifyRequest('/search', {
            token,
            query: { q: query, type: 'track', limit: 5 },
        });
        let track = search?.tracks?.items?.[0];
        if (!track) {
            search = await spotifyRequest('/search', {
                token,
                query: { q: `${suggestion.title} ${suggestion.artist}`, type: 'track', limit: 5 },
            });
            track = search?.tracks?.items?.[0];
        }
        if (!track) throw new SpotifyApiError(404, `Spotify could not find “${suggestion.title}” by ${suggestion.artist}.`);

        const devices = await spotifyRequest('/me/player/devices', { token });
        const available = (devices?.devices ?? []).filter(device => device.id && !device.is_restricted);
        const requestedDevice = cleanCredential(req.body?.deviceId);
        const device = available.find(item => item.id === requestedDevice)
            ?? available.find(item => item.is_active)
            ?? available[0];
        if (!device) {
            throw new SpotifyApiError(404, 'No controllable Spotify device is available. Open Spotify on a device and try again.');
        }

        await spotifyRequest('/me/player/play', {
            method: 'PUT',
            token,
            query: { device_id: device.id },
            body: { uris: [track.uri] },
        });
        const label = `${track.name} — ${track.artists?.map(artist => artist.name).join(', ') || suggestion.artist}`;
        res.json({
            success: true,
            message: `Playing ${label}`,
            track: {
                uri: track.uri,
                name: track.name,
                artists: track.artists?.map(artist => artist.name) ?? [],
                label,
                externalUrl: track.external_urls?.spotify ?? null,
            },
            device: { id: device.id, name: device.name, type: device.type },
        });
    }));

    router.use((error, _req, res, _next) => sendError(error, res));
    console.info(`${LOG_PREFIX} v${VERSION} initialized.`);
}

export async function exit() {
    clearTokens();
    pendingAuthStates.clear();
}

export const info = {
    id: 'moodmusic',
    name: 'Mood Music',
    description: 'Secure Spotify playback for the Mood Music SillyTavern extension.',
};

export default { init, exit, info };
