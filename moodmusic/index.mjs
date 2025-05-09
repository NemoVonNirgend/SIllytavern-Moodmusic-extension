// --- START OF FILE SillyTavern/plugins/moodmusic/index.mjs ---
import { Router } from 'express';
import { createRequire } from 'module';
import axios from 'axios';
// Verify this path is correct for your SillyTavern version/structure
// If you get errors about jsonParser, check where express-common.js lives relative to the plugins folder.
import { jsonParser } from '../../src/express-common.js';

const require = createRequire(import.meta.url);

// --- Configuration ---
let SPOTIFY_CLIENT_ID = process.env.MOODMUSIC_SPOTIFY_CLIENT_ID || null;
let SPOTIFY_CLIENT_SECRET = process.env.MOODMUSIC_SPOTIFY_CLIENT_SECRET || null;

const SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:8000/api/plugins/moodmusic/auth/callback'; // Default ST port

// --- State (Temporary - In-memory storage) ---
let accessToken = null;
let refreshToken = null; // This is key for long-term access
let tokenExpiryTime = null; // Timestamp (ms) when accessToken expires

// --- Spotify API URLs ---
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

// --- Scopes ---
const SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
].join(' ');

// --- Logging Prefix ---
const LOG_PREFIX_PLUGIN = '[MoodMusic Plugin]';

// --- Helper: Generate Random String ---
function generateRandomString(length) {
    if (typeof length !== 'number' || length <= 0) { throw new Error("Invalid length for generateRandomString"); }
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

// --- Helper: Check if Spotify credentials are configured ---
function areCredentialsConfigured() {
    return SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET;
}

// --- Helper: Get Valid Access Token (Handles Refresh) ---
async function getValidAccessToken() {
    const LOG_PREFIX_TOKEN = `${LOG_PREFIX_PLUGIN} [TokenHelper]`;

    if (!areCredentialsConfigured()) {
        console.error(`${LOG_PREFIX_TOKEN} Spotify Client ID or Secret not configured.`);
        throw new Error('Spotify Client ID or Secret not configured on the server.');
    }

    if (accessToken && tokenExpiryTime && Date.now() < tokenExpiryTime - (60 * 1000)) {
        console.log(`${LOG_PREFIX_TOKEN} Using existing, valid access token.`);
        return accessToken;
    }

    if (!refreshToken) {
        console.error(`${LOG_PREFIX_TOKEN} No refresh token available. Need to re-authenticate.`);
        return null;
    }

    console.log(`${LOG_PREFIX_TOKEN} Access token expired or missing. Attempting refresh...`);
    try {
        const authHeader = 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');
        const response = await axios.post(SPOTIFY_TOKEN_URL, new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        }), {
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        const data = response.data;
        accessToken = data.access_token;
        tokenExpiryTime = Date.now() + (data.expires_in * 1000);
        if (data.refresh_token) {
            refreshToken = data.refresh_token;
            console.log(`${LOG_PREFIX_TOKEN} Received NEW refresh token.`);
        }

        console.log(`${LOG_PREFIX_TOKEN} Token refreshed successfully.`);
        return accessToken;

    } catch (error) {
        console.error(`${LOG_PREFIX_TOKEN} Error refreshing access token:`, error.response ? error.response.data : error.message);
        accessToken = null;
        refreshToken = null;
        tokenExpiryTime = null;
        return null;
    }
}


/**
 * Initializes the plugin endpoints.
 * @param {Router} router The Express router instance.
 */
export async function init(router) {
    const LOG_PREFIX_INIT = `${LOG_PREFIX_PLUGIN} [Init]`;
    console.log(`${LOG_PREFIX_INIT} START - Initializing server plugin...`);
    if (SPOTIFY_CLIENT_ID) console.log(`${LOG_PREFIX_INIT} Spotify Client ID loaded (potentially from env).`);
    if (SPOTIFY_CLIENT_SECRET) console.log(`${LOG_PREFIX_INIT} Spotify Client Secret loaded (potentially from env - first few chars: ${SPOTIFY_CLIENT_SECRET.substring(0,3)}...).`);


    try {
        // === Configuration Endpoint (/config) ===
        console.log(`${LOG_PREFIX_INIT} Defining /config route...`);
        router.post('/config', jsonParser, (req, res) => {
            const LOG_PREFIX_ROUTE = `${LOG_PREFIX_PLUGIN} [/config POST]`;
            const { clientId, clientSecret } = req.body;
            console.log(`${LOG_PREFIX_ROUTE} Received request to set credentials.`);

            if (typeof clientId === 'string' && clientId.trim() !== '') {
                SPOTIFY_CLIENT_ID = clientId.trim();
                console.log(`${LOG_PREFIX_ROUTE} Spotify Client ID updated.`);
            } else {
                console.warn(`${LOG_PREFIX_ROUTE} Invalid or missing Client ID in request.`);
                return res.status(400).json({ success: false, message: 'Client ID is required and must be a non-empty string.' });
            }

            if (typeof clientSecret === 'string' && clientSecret.trim() !== '') {
                SPOTIFY_CLIENT_SECRET = clientSecret.trim();
                console.log(`${LOG_PREFIX_ROUTE} Spotify Client Secret updated.`);
            } else {
                console.warn(`${LOG_PREFIX_ROUTE} Invalid or missing Client Secret in request.`);
                return res.status(400).json({ success: false, message: 'Client Secret is required and must be a non-empty string.' });
            }
            // Invalidate existing tokens if credentials change, as they might be tied to old creds
            accessToken = null;
            refreshToken = null;
            tokenExpiryTime = null;
            console.log(`${LOG_PREFIX_ROUTE} Existing tokens cleared due to credential update.`);

            res.json({ success: true, message: 'Spotify credentials updated successfully.' });
        });

        router.get('/config', (req, res) => {
            const LOG_PREFIX_ROUTE = `${LOG_PREFIX_PLUGIN} [/config GET]`;
            // console.log(`${LOG_PREFIX_ROUTE} Request received for credential status.`); // Can be noisy
            res.json({
                clientIdSet: !!SPOTIFY_CLIENT_ID,
                clientSecretSet: !!SPOTIFY_CLIENT_SECRET,
            });
        });
        console.log(`${LOG_PREFIX_INIT} /config route DEFINED.`);


        // === Authentication Start (/auth/login) ===
        console.log(`${LOG_PREFIX_INIT} Defining /auth/login route...`);
        router.get('/auth/login', (req, res) => {
            const LOG_PREFIX_ROUTE = `${LOG_PREFIX_PLUGIN} [/auth/login]`;
            console.log(`${LOG_PREFIX_ROUTE} Request received.`);
            if (!areCredentialsConfigured()) {
                console.error(`${LOG_PREFIX_ROUTE} Spotify credentials not set. Cannot initiate login.`);
                return res.status(400).send('Spotify Client ID or Secret not configured on the server. Please configure them first.');
            }
            try {
                const authUrl = new URL(SPOTIFY_AUTH_URL);
                authUrl.searchParams.append('response_type', 'code');
                authUrl.searchParams.append('client_id', SPOTIFY_CLIENT_ID);
                authUrl.searchParams.append('scope', SCOPES);
                authUrl.searchParams.append('redirect_uri', SPOTIFY_REDIRECT_URI);
                console.log(`${LOG_PREFIX_ROUTE} Redirecting to: ${authUrl.toString()}`);
                res.redirect(authUrl.toString());
            } catch (error) {
                console.error(`${LOG_PREFIX_ROUTE} Error:`, error);
                res.status(500).send('Internal Server Error during login setup.');
            }
        });
        console.log(`${LOG_PREFIX_INIT} /auth/login route DEFINED.`);

        // === Authentication Callback (/auth/callback) ===
        console.log(`${LOG_PREFIX_INIT} Defining /auth/callback route...`);
        router.get('/auth/callback', async (req, res) => {
            const LOG_PREFIX_ROUTE = `${LOG_PREFIX_PLUGIN} [/auth/callback]`;
            console.log(`${LOG_PREFIX_ROUTE} Request received.`);

            if (!areCredentialsConfigured()) {
                console.error(`${LOG_PREFIX_ROUTE} Spotify credentials not set during callback. This should not happen if login was initiated correctly.`);
                // This is an unlikely scenario if /auth/login checks, but good for robustness
                return res.status(400).send(`
                    <html><body><h1>Configuration Error</h1>
                    <p>Spotify credentials seem to be missing on the server. Please reconfigure and try again.</p>
                    <button onclick="window.close()">Close</button></body></html>`);
            }

            const code = req.query.code || null;
            const error = req.query.error || null;

            if (error) {
                console.error(`${LOG_PREFIX_ROUTE} Spotify Callback Error:`, error);
                res.status(400).send(`
                    <html><body><h1>Spotify Login Error</h1>
                    <p>An error occurred: <strong>${error}</strong></p>
                    <button onclick="window.close()">Close</button></body></html>`);
                return;
            }
            if (!code) {
                console.error(`${LOG_PREFIX_ROUTE} No authorization code received.`);
                res.status(400).send(`
                    <html><body><h1>Spotify Login Error</h1>
                    <p>No authorization code from Spotify.</p>
                    <button onclick="window.close()">Close</button></body></html>`);
                return;
            }

            console.log(`${LOG_PREFIX_ROUTE} Exchanging authorization code for tokens...`);
            try {
                const authHeader = 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');
                const tokenResponse = await axios.post(SPOTIFY_TOKEN_URL, new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: SPOTIFY_REDIRECT_URI,
                }), {
                    headers: {
                        'Authorization': authHeader,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    }
                });

                const data = tokenResponse.data;
                accessToken = data.access_token;
                refreshToken = data.refresh_token;
                tokenExpiryTime = Date.now() + (data.expires_in * 1000);
                console.log(`${LOG_PREFIX_ROUTE} Tokens obtained successfully!`);
                res.send('<script>alert("Spotify Login Successful! You can close this tab."); window.close();</script>');

            } catch (err) {
                console.error(`${LOG_PREFIX_ROUTE} Error exchanging code:`, err.response ? err.response.data : err.message);
                res.status(500).send(`
                    <html><body><h1>Spotify Login Error</h1>
                    <p>Failed to get tokens. Details: ${err.message}</p>
                    <button onclick="window.close()">Close</button></body></html>`);
            }
        });
        console.log(`${LOG_PREFIX_INIT} /auth/callback route DEFINED.`);

        // === Authentication Status (/auth/status) ===
        console.log(`${LOG_PREFIX_INIT} Defining /auth/status route...`);
        router.get('/auth/status', (req, res) => {
            const LOG_PREFIX_ROUTE = `${LOG_PREFIX_PLUGIN} [/auth/status]`;
             if (!areCredentialsConfigured()) {
                 // console.log(`${LOG_PREFIX_ROUTE} Status: Credentials not set.`);
                 return res.json({ loggedIn: false, credentialsSet: false });
             }
            if (refreshToken) { // Primary check is refreshToken for persistent login status
                // console.log(`${LOG_PREFIX_ROUTE} Status: Logged In (Refresh token exists).`);
                res.json({ loggedIn: true, credentialsSet: true });
            } else {
                // console.log(`${LOG_PREFIX_ROUTE} Status: Not Logged In (No refresh token), but creds are set.`);
                res.json({ loggedIn: false, credentialsSet: true });
            }
        });
        console.log(`${LOG_PREFIX_INIT} /auth/status route DEFINED.`);

        // === Get Playback State (/playback/state) ===
        console.log(`${LOG_PREFIX_INIT} Defining /playback/state route...`);
        router.get('/playback/state', async (req, res) => {
            const LOG_PREFIX_ROUTE = `${LOG_PREFIX_PLUGIN} [/playback/state]`;
            if (!areCredentialsConfigured()) {
                // console.warn(`${LOG_PREFIX_ROUTE} Credentials not set. Cannot get playback state.`);
                return res.status(400).json({ is_playing: false, error: 'Spotify credentials not configured.', needsLogin: false, needsConfiguration: true });
            }
            try {
                const currentAccessToken = await getValidAccessToken();
                if (!currentAccessToken) {
                     // console.warn(`${LOG_PREFIX_ROUTE} No valid access token. Needs login.`);
                     return res.status(401).json({ is_playing: false, error: 'Authentication required.', needsLogin: true, needsConfiguration: false });
                }
                const stateResponse = await axios.get(`${SPOTIFY_API_BASE}/me/player`, {
                    headers: { 'Authorization': `Bearer ${currentAccessToken}` },
                    params: { market: 'from_token' }
                });
                if (stateResponse.status === 204 || !stateResponse.data) {
                    return res.json({ is_playing: false, item: null, progress_ms: 0, device: null });
                }
                const data = stateResponse.data;
                res.json({
                    is_playing: data.is_playing,
                    item: data.item ? {
                        id: data.item.id, uri: data.item.uri, name: data.item.name,
                        duration_ms: data.item.duration_ms, artists: data.item.artists?.map(a => a.name) || []
                    } : null,
                    progress_ms: data.progress_ms,
                    device: data.device ? {
                        id: data.device.id, name: data.device.name, is_active: data.device.is_active
                    } : null,
                    timestamp: data.timestamp
                });
            } catch (error) {
                console.error(`${LOG_PREFIX_ROUTE} Error fetching playback state:`, error.response ? error.response.data : error.message);
                if (error.response?.status === 401) {
                     accessToken = null; tokenExpiryTime = null;
                     return res.status(401).json({ is_playing: false, error: 'Spotify token invalid.', needsLogin: !refreshToken, needsConfiguration: false });
                }
                if (error.message?.includes('Spotify Client ID or Secret not configured')) { // Catch error from getValidAccessToken
                    return res.status(400).json({ is_playing: false, error: error.message, needsLogin: false, needsConfiguration: true });
                }
                 return res.json({ is_playing: false, item: null, progress_ms: 0, device: null, error: 'Could not fetch state' });
            }
        });
        console.log(`${LOG_PREFIX_INIT} /playback/state route DEFINED.`);


        // === Play Endpoint (/play) ===
        console.log(`${LOG_PREFIX_INIT} Defining /play route...`);
        router.post('/play', jsonParser, async (req, res) => {
            const LOG_PREFIX_ROUTE = `${LOG_PREFIX_PLUGIN} [/play]`;
            console.log(`${LOG_PREFIX_ROUTE} Request received.`);

            if (!areCredentialsConfigured()) {
                console.warn(`${LOG_PREFIX_ROUTE} Credentials not set. Cannot play song.`);
                return res.status(400).json({ success: false, message: 'Spotify credentials not configured on the server.', needsConfiguration: true });
            }

            const suggestion = req.body.suggestion;
            if (!suggestion || !suggestion.title || typeof suggestion.title !== 'string') {
                console.warn(`${LOG_PREFIX_ROUTE} Invalid suggestion format received:`, suggestion);
                return res.status(400).json({ success: false, message: 'Invalid song suggestion format (missing title).' });
            }

            try {
                const currentAccessToken = await getValidAccessToken();
                 if (!currentAccessToken) {
                     console.warn(`${LOG_PREFIX_ROUTE} No valid access token. Cannot play song. Needs login.`);
                     return res.status(401).json({ success: false, message: 'Spotify authentication required. Please log in.', needsLogin: true });
                 }
                console.log(`${LOG_PREFIX_ROUTE} Obtained valid access token.`);

                const searchQuery = `track:${suggestion.title.trim()}${suggestion.artist ? ' artist:' + suggestion.artist.trim() : ''}`;
                console.log(`${LOG_PREFIX_ROUTE} Searching Spotify query: "${searchQuery}"`);
                const searchResponse = await axios.get(`${SPOTIFY_API_BASE}/search`, {
                    headers: { 'Authorization': `Bearer ${currentAccessToken}` },
                    params: { q: searchQuery, type: 'track', limit: 1 }
                });

                if (!searchResponse.data?.tracks?.items?.length) {
                    console.warn(`${LOG_PREFIX_ROUTE} No track found for query: "${searchQuery}"`);
                    return res.status(404).json({ success: false, message: `Song "${suggestion.title}" not found on Spotify.` });
                }

                const track = searchResponse.data.tracks.items[0];
                const trackUri = track.uri;
                const trackName = track.name;
                const trackArtists = track.artists.map(a => a.name).join(', ');
                console.log(`${LOG_PREFIX_ROUTE} Found track: ${trackName} by ${trackArtists} (URI: ${trackUri})`);

                console.log(`${LOG_PREFIX_ROUTE} Looking for active Spotify devices...`);
                const devicesResponse = await axios.get(`${SPOTIFY_API_BASE}/me/player/devices`, {
                    headers: { 'Authorization': `Bearer ${currentAccessToken}` }
                });

                if (!devicesResponse.data?.devices?.length) {
                    console.warn(`${LOG_PREFIX_ROUTE} No Spotify devices found for the user.`);
                     return res.status(404).json({ success: false, message: 'No Spotify device found. Is Spotify open on any device?' });
                }

                let targetDevice = devicesResponse.data.devices.find(device => device.is_active);
                let deviceId, deviceName;
                if (targetDevice) {
                    deviceId = targetDevice.id; deviceName = targetDevice.name;
                    console.log(`${LOG_PREFIX_ROUTE} Found active device: ${deviceName} (ID: ${deviceId})`);
                } else {
                     targetDevice = devicesResponse.data.devices[0];
                     deviceId = targetDevice.id; deviceName = targetDevice.name;
                     console.log(`${LOG_PREFIX_ROUTE} No active device, using first available: ${deviceName} (ID: ${deviceId})`);
                }

                console.log(`${LOG_PREFIX_ROUTE} Sending play command to device ${deviceName} for track ${trackUri}`);
                await axios.put(`${SPOTIFY_API_BASE}/me/player/play`,
                    { uris: [trackUri] },
                    {
                        headers: { 'Authorization': `Bearer ${currentAccessToken}`, 'Content-Type': 'application/json' },
                        params: { device_id: deviceId }
                    }
                 );

                 console.log(`${LOG_PREFIX_ROUTE} Play command sent successfully.`);
                 res.json({
                     success: true, message: `Play command sent for "${trackName}" on ${deviceName}.`,
                     trackUri: trackUri, trackName: trackName
                 });

            } catch (error) {
                 console.error(`${LOG_PREFIX_ROUTE} Error during playback:`, error.response ? JSON.stringify(error.response.data) : error.message);
                 if (error.message?.includes('Spotify Client ID or Secret not configured')) { // Catch error from getValidAccessToken
                    return res.status(400).json({ success: false, message: error.message, needsConfiguration: true });
                 }
                 if (error.response?.data?.error) {
                      const spotifyError = error.response.data.error;
                      if (spotifyError.reason === 'NO_ACTIVE_DEVICE' || spotifyError.reason === 'PREMIUM_REQUIRED' || spotifyError.reason === 'COMMAND_DISALLOWED') {
                          return res.status(error.response.status || 403).json({ success: false, message: `Spotify Error: ${spotifyError.message}` });
                      }
                       if (error.response.status === 401) {
                           accessToken = null; tokenExpiryTime = null;
                           return res.status(401).json({ success: false, message: 'Spotify token invalid.', needsLogin: !refreshToken });
                       }
                       return res.status(error.response.status || 500).json({ success: false, message: `Spotify API Error: ${spotifyError.message}` });
                 }
                 res.status(500).json({ success: false, message: error.message || 'Internal server error during playback.' });
            }
        });
        console.log(`${LOG_PREFIX_INIT} /play route DEFINED.`);

        console.log(`${LOG_PREFIX_INIT} Defining /ping route...`);
        router.get('/ping', (req, res) => res.status(200).json({ message: 'MoodMusic Plugin Pong!', timestamp: Date.now() }));
        console.log(`${LOG_PREFIX_INIT} /ping route DEFINED.`);

    } catch (initError) {
        console.error(`${LOG_PREFIX_INIT} !!!!! CRITICAL ERROR DURING PLUGIN INITIALIZATION !!!!!`, initError);
    }
    console.log(`${LOG_PREFIX_INIT} END - Server plugin initialization sequence finished.`);
}

export async function exit() {
    console.log(`${LOG_PREFIX_PLUGIN} Exiting server plugin...`);
}

const moodMusicModule = {
    init, exit,
    info: { id: 'moodmusic', name: 'Mood Music', description: 'Plays Spotify music based on chat mood analysis.' },
};
export default moodMusicModule;
// --- END OF FILE SillyTavern/plugins/moodmusic/index.mjs ---