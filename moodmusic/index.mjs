// --- START OF FILE SillyTavern/plugins/moodmusic/index.mjs ---
import { Router } from 'express';
import axios from 'axios';
import { jsonParser } from '../../src/express-common.js';

// --- Configuration ---
let SPOTIFY_CLIENT_ID = process.env.MOODMUSIC_SPOTIFY_CLIENT_ID || null;
let SPOTIFY_CLIENT_SECRET = process.env.MOODMUSIC_SPOTIFY_CLIENT_SECRET || null;

// The redirect URI must exactly match the one in your Spotify Developer Dashboard
const getRedirectUri = (req) => {
    const host = req.get('host'); // e.g., 'localhost:8000' or '127.0.0.1:8000'
    const protocol = req.protocol; // http or https
    return `${protocol}://${host}/api/plugins/moodmusic/auth/callback`;
};


// --- State (In-memory storage) ---
let accessToken = null;
let refreshToken = null;
let tokenExpiryTime = null; // Timestamp (ms) when accessToken expires

// --- Spotify API URLs & Scopes ---
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';

const LOG_PREFIX_PLUGIN = '[MoodMusic Plugin]';

// --- Helper Functions ---

function areCredentialsConfigured() {
    return SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET;
}

// OPTIMIZED: Helper to send a simple HTML response to the user's popup window
function sendHtmlResponse(res, title, message, isSuccess = true) {
    const color = isSuccess ? '#4CAF50' : '#F44336';
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>${title}</title>
            <style>
                body { font-family: sans-serif; background-color: #252525; color: #f1f1f1; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .container { text-align: center; padding: 2em; border: 1px solid #444; border-radius: 8px; background-color: #333; }
                h1 { color: ${color}; }
                button { background-color: #555; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-top: 1em; }
                button:hover { background-color: #666; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>${isSuccess ? 'Success!' : 'Error'}</h1>
                <p>${message}</p>
                <button onclick="window.close()">Close this window</button>
            </div>
            <script>
                // For successful auth, we can also add an alert.
                if (${isSuccess}) {
                    alert("Spotify Login Successful! You can now close this tab.");
                }
                // Automatically close the window after a few seconds for convenience
                // setTimeout(() => window.close(), 3000);
            </script>
        </body>
        </html>`;
    res.send(html);
}


async function getValidAccessToken() {
    const LOG_PREFIX_TOKEN = `${LOG_PREFIX_PLUGIN} [TokenHelper]`;

    if (!areCredentialsConfigured()) {
        throw new Error('Spotify Client ID or Secret not configured on the server.');
    }

    // Return current token if it's still valid (with a 60-second buffer)
    if (accessToken && tokenExpiryTime && Date.now() < tokenExpiryTime - 60000) {
        return accessToken;
    }

    if (!refreshToken) {
        console.error(`${LOG_PREFIX_TOKEN} No refresh token available. User needs to re-authenticate.`);
        return null; // Signals to the caller that re-authentication is needed
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

        accessToken = response.data.access_token;
        tokenExpiryTime = Date.now() + (response.data.expires_in * 1000);
        // Spotify may optionally issue a new refresh token
        if (response.data.refresh_token) {
            refreshToken = response.data.refresh_token;
            console.log(`${LOG_PREFIX_TOKEN} Received a NEW refresh token.`);
        }
        console.log(`${LOG_PREFIX_TOKEN} Token refreshed successfully.`);
        return accessToken;

    } catch (error) {
        console.error(`${LOG_PREFIX_TOKEN} Error refreshing access token:`, error.response ? error.response.data : error.message);
        // If refresh fails, clear all tokens to force a new login
        accessToken = null;
        refreshToken = null;
        tokenExpiryTime = null;
        return null;
    }
}

export async function init(router) {
    const LOG_PREFIX_INIT = `${LOG_PREFIX_PLUGIN} [Init]`;
    console.log(`${LOG_PREFIX_INIT} Initializing MoodMusic server plugin...`);

    // === Configuration Endpoint (/config) ===
    router.post('/config', jsonParser, (req, res) => {
        const { clientId, clientSecret } = req.body;
        if (!clientId || typeof clientId !== 'string' || !clientSecret || typeof clientSecret !== 'string') {
            return res.status(400).json({ success: false, message: 'Client ID and Client Secret are required.' });
        }
        SPOTIFY_CLIENT_ID = clientId.trim();
        SPOTIFY_CLIENT_SECRET = clientSecret.trim();
        // Invalidate existing tokens, as they are tied to the old credentials
        accessToken = null;
        refreshToken = null;
        tokenExpiryTime = null;
        console.log(`${LOG_PREFIX_PLUGIN} [/config] Credentials updated. Existing tokens cleared.`);
        res.json({ success: true, message: 'Spotify credentials updated successfully.' });
    });

    router.get('/config', (req, res) => {
        res.json({
            clientIdSet: !!SPOTIFY_CLIENT_ID,
            clientSecretSet: !!SPOTIFY_CLIENT_SECRET,
        });
    });

    // === Authentication Start (/auth/login) ===
    router.get('/auth/login', (req, res) => {
        if (!areCredentialsConfigured()) {
            console.error(`${LOG_PREFIX_PLUGIN} [/auth/login] Attempted login before credentials were set.`);
            return sendHtmlResponse(res, 'Configuration Error', 'Spotify Client ID or Secret not configured on the server.', false);
        }
        const redirectUri = getRedirectUri(req);
        const authUrl = new URL(SPOTIFY_AUTH_URL);
        authUrl.search = new URLSearchParams({
            response_type: 'code',
            client_id: SPOTIFY_CLIENT_ID,
            scope: SCOPES,
            redirect_uri: redirectUri,
        }).toString();
        console.log(`${LOG_PREFIX_PLUGIN} [/auth/login] Redirecting user to Spotify for authentication.`);
        res.redirect(authUrl.toString());
    });

    // === Authentication Callback (/auth/callback) ===
    router.get('/auth/callback', async (req, res) => {
        const { code, error } = req.query;
        if (error) {
            console.error(`${LOG_PREFIX_PLUGIN} [/auth/callback] Spotify returned an error: ${error}`);
            return sendHtmlResponse(res, 'Spotify Login Error', `An error occurred: <strong>${error}</strong>`, false);
        }
        if (!code) {
            return sendHtmlResponse(res, 'Spotify Login Error', 'No authorization code received from Spotify.', false);
        }

        try {
            const redirectUri = getRedirectUri(req);
            const authHeader = 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');
            const tokenResponse = await axios.post(SPOTIFY_TOKEN_URL, new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri,
            }), {
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            accessToken = tokenResponse.data.access_token;
            refreshToken = tokenResponse.data.refresh_token;
            tokenExpiryTime = Date.now() + (tokenResponse.data.expires_in * 1000);
            console.log(`${LOG_PREFIX_PLUGIN} [/auth/callback] Authorization successful. Tokens obtained.`);
            sendHtmlResponse(res, 'Login Successful', 'You can now close this window.');

        } catch (err) {
            console.error(`${LOG_PREFIX_PLUGIN} [/auth/callback] Error exchanging code for tokens:`, err.response ? err.response.data : err.message);
            sendHtmlResponse(res, 'Spotify Login Error', 'Failed to exchange authorization code for tokens. Check server logs.', false);
        }
    });

    // === Authentication Status (/auth/status) ===
    router.get('/auth/status', (req, res) => {
        res.json({
            loggedIn: !!refreshToken, // The presence of a refresh token is the true indicator of a persistent login
            credentialsSet: areCredentialsConfigured(),
        });
    });

    // Middleware to protect subsequent routes
    const requireAuth = async (req, res, next) => {
        if (!areCredentialsConfigured()) {
            return res.status(400).json({ error: 'Spotify credentials not configured.', needsConfiguration: true });
        }
        const token = await getValidAccessToken();
        if (!token) {
            return res.status(401).json({ error: 'Authentication required.', needsLogin: true });
        }
        req.accessToken = token; // Attach token for use in next handlers
        next();
    };


    // === Get Playback State (/playback/state) ===
    router.get('/playback/state', requireAuth, async (req, res) => {
        try {
            const stateResponse = await axios.get(`${SPOTIFY_API_BASE}/me/player`, {
                headers: { 'Authorization': `Bearer ${req.accessToken}` },
            });
            // 204 No Content means no active player
            if (stateResponse.status === 204 || !stateResponse.data) {
                return res.json({ is_playing: false, item: null });
            }
            res.json(stateResponse.data);
        } catch (error) {
            console.error(`${LOG_PREFIX_PLUGIN} [/playback/state] Error fetching playback state:`, error.response ? error.response.data : error.message);
            res.status(500).json({ error: 'Could not fetch playback state.' });
        }
    });


    // === Play Endpoint (/play) ===
    router.post('/play', jsonParser, requireAuth, async (req, res) => {
        const { suggestion } = req.body;
        if (!suggestion?.title) {
            return res.status(400).json({ success: false, message: 'Invalid song suggestion format.' });
        }

        try {
            // 1. Search for the track
            const searchQuery = `track:${suggestion.title.trim()}${suggestion.artist ? ` artist:${suggestion.artist.trim()}` : ''}`;
            const searchResponse = await axios.get(`${SPOTIFY_API_BASE}/search`, {
                headers: { 'Authorization': `Bearer ${req.accessToken}` },
                params: { q: searchQuery, type: 'track', limit: 1 }
            });

            const track = searchResponse.data?.tracks?.items?.[0];
            if (!track) {
                return res.status(404).json({ success: false, message: `Song "${suggestion.title}" not found.` });
            }

            // 2. Find an active device
            const devicesResponse = await axios.get(`${SPOTIFY_API_BASE}/me/player/devices`, {
                headers: { 'Authorization': `Bearer ${req.accessToken}` }
            });

            const activeDevice = devicesResponse.data?.devices?.find(d => d.is_active);
            const deviceId = activeDevice?.id;
            if (!deviceId) {
                console.warn(`${LOG_PREFIX_PLUGIN} [/play] No active Spotify device found. Available devices:`, devicesResponse.data?.devices);
                return res.status(404).json({ success: false, message: 'No active Spotify device found. Please start playing on a device first.' });
            }

            // 3. Send the play command
            await axios.put(`${SPOTIFY_API_BASE}/me/player/play`,
                { uris: [track.uri] },
                { headers: { 'Authorization': `Bearer ${req.accessToken}` }, params: { device_id: deviceId } }
            );

            const trackName = `${track.name} by ${track.artists.map(a => a.name).join(', ')}`;
            console.log(`${LOG_PREFIX_PLUGIN} [/play] Play command sent for "${trackName}" to device ${activeDevice.name}.`);
            res.json({ success: true, message: `Playing "${trackName}"`, trackUri: track.uri });

        } catch (error) {
            console.error(`${LOG_PREFIX_PLUGIN} [/play] Error during playback sequence:`, error.response ? error.response.data : error.message);
            const spotifyError = error.response?.data?.error;
            if (spotifyError) {
                return res.status(error.response.status).json({ success: false, message: `Spotify Error: ${spotifyError.message}` });
            }
            res.status(500).json({ success: false, message: 'An internal server error occurred.' });
        }
    });

    console.log(`${LOG_PREFIX_INIT} MoodMusic plugin routes initialized successfully.`);
}

export async function exit() {
    console.log(`${LOG_PREFIX_PLUGIN} Exiting server plugin.`);
}

const moodMusicModule = {
    init, exit,
    info: { id: 'moodmusic', name: 'Mood Music', description: 'Plays Spotify music based on chat mood analysis.' },
};
export default moodMusicModule;