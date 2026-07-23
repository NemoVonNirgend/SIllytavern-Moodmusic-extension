/* global $ */

import {
    DEFAULT_SETTINGS,
    buildChatExcerpt,
    normalizeSettings,
    parseMusicSuggestion,
    shouldAnalyze,
} from './src/core.js';
import {
    eventSource,
    event_types,
    generateRaw,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

const EXTENSION_NAME = new URL('.', import.meta.url).pathname.split('/').filter(Boolean).at(-1);
const SETTINGS_KEY = 'moodMusic';
const API_BASE = '/api/plugins/moodmusic';
const LOG_PREFIX = '[Mood Music]';

let settings;
let initialized = false;
let authenticated = false;
let credentialsSet = false;
let analysisInProgress = false;
let pollTimer = null;
let analysisTimer = null;
let lastAnalyzedSignature = '';
let lastSuggestionAt = 0;

function notify(level, message) {
    const method = globalThis.toastr?.[level] ?? globalThis.toastr?.info;
    if (typeof method === 'function') {
        method(message, 'Mood Music');
    } else {
        console[level === 'error' ? 'error' : 'log'](`${LOG_PREFIX} ${message}`);
    }
}

async function apiRequest(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
        const response = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                ...getRequestHeaders(),
                ...options.headers,
            },
            signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(body.message || body.error || `Request failed (${response.status})`);
            error.status = response.status;
            error.details = body;
            throw error;
        }
        return body;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('The Mood Music server plugin did not respond in time.');
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function persistSettings() {
    extension_settings[SETTINGS_KEY] = settings;
    saveSettingsDebounced();
}

function updateControls() {
    $('#moodmusic-enabled').prop('checked', settings.enabled);
    $('#moodmusic-auto-suggest').prop('checked', settings.autoSuggest);
    $('#moodmusic-only-when-idle').prop('checked', settings.onlyWhenIdle);
    $('#moodmusic-history-messages').val(settings.historyMessages);
    $('#moodmusic-cooldown-minutes').val(settings.cooldownMinutes);
    $('#moodmusic-poll-seconds').val(settings.pollIntervalSeconds);
    $('#moodmusic-prompt').val(settings.prompt);

    $('#moodmusic-creds-status')
        .text(credentialsSet ? 'Configured' : 'Not configured')
        .toggleClass('moodmusic-status-ok', credentialsSet);
    $('#moodmusic-status')
        .text(authenticated ? 'Connected' : (credentialsSet ? 'Login required' : 'Setup required'))
        .toggleClass('moodmusic-status-ok', authenticated);
    $('#moodmusic-login-button').prop('disabled', !credentialsSet).toggle(!authenticated);
    $('#moodmusic-logout-button').toggle(authenticated);
    $('#moodmusic-suggest-button').prop('disabled', !authenticated || analysisInProgress);
}

async function refreshServerStatus({ quiet = true } = {}) {
    try {
        const status = await apiRequest('/auth/status');
        authenticated = Boolean(status.loggedIn);
        credentialsSet = Boolean(status.credentialsSet);
        updateControls();
        return status;
    } catch (error) {
        authenticated = false;
        credentialsSet = false;
        updateControls();
        if (!quiet) notify('error', error.message);
        return null;
    }
}

async function saveCredentials() {
    const clientId = String($('#moodmusic-client-id').val() || '').trim();
    const clientSecret = String($('#moodmusic-client-secret').val() || '').trim();
    if (!clientId || !clientSecret) {
        notify('warning', 'Enter both the Spotify client ID and client secret.');
        return;
    }

    try {
        await apiRequest('/config', {
            method: 'POST',
            body: JSON.stringify({ clientId, clientSecret }),
        });
        $('#moodmusic-client-secret').val('');
        notify('success', 'Spotify credentials saved for this server session.');
        await refreshServerStatus();
    } catch (error) {
        notify('error', error.message);
    }
}

function login() {
    if (!credentialsSet) return;
    const popup = window.open(
        `${API_BASE}/auth/login`,
        'MoodMusicSpotifyLogin',
        'popup=yes,width=620,height=760,scrollbars=yes',
    );
    if (!popup) {
        notify('warning', 'Allow popups for SillyTavern, then try Spotify login again.');
        return;
    }

    const timer = setInterval(async () => {
        if (popup.closed) {
            clearInterval(timer);
            await refreshServerStatus({ quiet: false });
            if (authenticated) notify('success', 'Spotify connected.');
        }
    }, 750);
}

async function logout() {
    try {
        await apiRequest('/auth/logout', { method: 'POST', body: '{}' });
        authenticated = false;
        updateControls();
        notify('success', 'Spotify disconnected.');
    } catch (error) {
        notify('error', error.message);
    }
}

function getChatSnapshot() {
    const excerpt = buildChatExcerpt(getContext().chat, settings.historyMessages);
    return {
        excerpt,
        signature: excerpt,
    };
}

async function getPlaybackState() {
    if (!authenticated) return null;
    try {
        return await apiRequest('/playback/state');
    } catch (error) {
        if (error.status === 401) await refreshServerStatus();
        console.warn(`${LOG_PREFIX} Could not read playback state:`, error);
        return null;
    }
}

async function generateSuggestion(excerpt) {
    const jsonSchema = {
        type: 'object',
        additionalProperties: false,
        properties: {
            title: { type: 'string' },
            artist: { type: 'string' },
        },
        required: ['title', 'artist'],
    };
    const response = await generateRaw({
        prompt: `Conversation excerpt:\n\n${excerpt}`,
        systemPrompt: settings.prompt,
        responseLength: 120,
        jsonSchema,
    });
    return parseMusicSuggestion(response);
}

async function analyzeAndPlay({ manual = false } = {}) {
    if (analysisInProgress || !settings.enabled || !authenticated) return;

    const { excerpt, signature } = getChatSnapshot();
    const eligibility = shouldAnalyze({
        manual,
        autoSuggest: settings.autoSuggest,
        excerpt,
        signature,
        lastAnalyzedSignature,
        lastSuggestionAt,
        cooldownMinutes: settings.cooldownMinutes,
    });
    if (!eligibility.allowed) {
        if (manual) notify('warning', eligibility.reason);
        return;
    }

    analysisInProgress = true;
    updateControls();
    try {
        if (!manual && settings.onlyWhenIdle) {
            const playback = await getPlaybackState();
            if (playback?.isPlaying) return;
        }

        const suggestion = await generateSuggestion(excerpt);
        if (!suggestion) throw new Error('The model did not return a usable title and artist.');

        const result = await apiRequest('/play', {
            method: 'POST',
            body: JSON.stringify({ suggestion }),
        });
        lastAnalyzedSignature = signature;
        lastSuggestionAt = Date.now();
        $('#moodmusic-now-playing').text(result.track?.label || `${suggestion.title} — ${suggestion.artist}`);
        notify('success', result.message || 'Started Spotify playback.');
    } catch (error) {
        if (error.status === 401) await refreshServerStatus();
        notify('error', error.message);
    } finally {
        analysisInProgress = false;
        updateControls();
    }
}

function scheduleAnalysis(delay = 1_500) {
    clearTimeout(analysisTimer);
    analysisTimer = setTimeout(() => analyzeAndPlay(), delay);
}

function restartPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (!settings.enabled) return;
    pollTimer = setInterval(async () => {
        const status = await refreshServerStatus();
        if (status?.loggedIn) scheduleAnalysis(0);
    }, settings.pollIntervalSeconds * 1_000);
}

function bindSettings() {
    $('#moodmusic-enabled').on('change', function () {
        settings.enabled = Boolean($(this).prop('checked'));
        persistSettings();
        restartPolling();
        updateControls();
    });
    $('#moodmusic-auto-suggest, #moodmusic-only-when-idle').on('change', function () {
        const key = this.id === 'moodmusic-auto-suggest' ? 'autoSuggest' : 'onlyWhenIdle';
        settings[key] = Boolean($(this).prop('checked'));
        persistSettings();
    });
    $('#moodmusic-history-messages, #moodmusic-cooldown-minutes, #moodmusic-poll-seconds').on('change', function () {
        const keys = {
            'moodmusic-history-messages': 'historyMessages',
            'moodmusic-cooldown-minutes': 'cooldownMinutes',
            'moodmusic-poll-seconds': 'pollIntervalSeconds',
        };
        settings[keys[this.id]] = Number($(this).val());
        settings = normalizeSettings(settings);
        persistSettings();
        restartPolling();
        updateControls();
    });
    $('#moodmusic-prompt').on('change', function () {
        settings.prompt = String($(this).val() || '').trim() || DEFAULT_SETTINGS.prompt;
        persistSettings();
        updateControls();
    });
    $('#moodmusic-reset-prompt').on('click', () => {
        settings.prompt = DEFAULT_SETTINGS.prompt;
        persistSettings();
        updateControls();
    });
    $('#moodmusic-save-creds-button').on('click', saveCredentials);
    $('#moodmusic-login-button').on('click', login);
    $('#moodmusic-logout-button').on('click', logout);
    $('#moodmusic-refresh-button').on('click', () => refreshServerStatus({ quiet: false }));
    $('#moodmusic-suggest-button').on('click', () => analyzeAndPlay({ manual: true }));
}

export async function activate() {
    if (initialized) return;
    initialized = true;
    settings = normalizeSettings(extension_settings[SETTINGS_KEY]);
    extension_settings[SETTINGS_KEY] = settings;

    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    $('#extensions_settings').append(html);
    bindSettings();
    updateControls();
    await refreshServerStatus();
    restartPolling();

    eventSource.on(event_types.MESSAGE_RECEIVED, () => scheduleAnalysis());
    eventSource.on(event_types.CHAT_CHANGED, () => {
        lastAnalyzedSignature = '';
        clearTimeout(analysisTimer);
    });
    console.info(`${LOG_PREFIX} v3 initialized.`);
}

export function onDisable() {
    clearInterval(pollTimer);
    clearTimeout(analysisTimer);
}

export function onEnable() {
    if (initialized) restartPolling();
}
