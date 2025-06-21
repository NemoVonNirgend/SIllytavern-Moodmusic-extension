// --- START OF FILE index.js ---

import { getContext } from '../../../extensions.js';
// We don't import getCsrfToken, as we will access it directly from the DOM.
import { callPopup, eventSource, event_types, generateQuietPrompt, generateRaw } from '../../../../script.js';

const extensionName = "SIllytavern-Moodmusic-Ext";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const PLUGIN_API_BASE = '/api/plugins/moodmusic';
const LOG_PREFIX = "[MoodMusic Ext]";

// Configuration and State Variables
const MUSIC_PRESET_NAME = "Music";
const POLLING_INTERVAL_MS = 10000;
const MOOD_ANALYSIS_TRIGGER_THRESHOLD_MS = 10000;
const HISTORY_FOR_MOOD_ANALYSIS = 8;

let isInitialized = false;
let isAuthenticated = false; // Spotify login status
let areServerCredentialsSet = false; // Server-side Spotify App Client ID/Secret status
let isPollingPlayback = false;
let pollingIntervalId = null;
let currentlyPlayingTrackUri = null;
let currentPresetRestorationRequired = false;
let originalPresetName = null;
let $presetDropdown = null; // Cached jQuery object for the preset dropdown
let lastPlaybackStopTime = 0;
let isAnalysisInProgress = false;
let isExtensionActive = true;

// OPTIMIZED: Helper to get standard API headers with CSRF token
function getApiHeaders() {
    return {
        'Content-Type': 'application/json',
        // DEFINITIVE FIX: Read the CSRF token directly from the body's data attribute.
        // This is the most robust method and avoids issues with function scope or timing.
        'X-CSRF-Token': $('body').data('csrf-token'),
    };
}


// UI Update Functions
function updateCredentialsStatusUI(status) {
    const credsStatusText = $('#moodmusic-creds-status');
    const loginButton = $('#moodmusic-login-button');
    if (!credsStatusText.length) { console.warn(`${LOG_PREFIX} [updateCredsUI] Creds status UI not found.`); return; }

    if (status && status.clientIdSet && status.clientSecretSet) {
        credsStatusText.text('Set').css('color', 'lightgreen');
        areServerCredentialsSet = true;
        loginButton.prop('disabled', false).attr('title', 'Login to Spotify');
    } else {
        let msg = 'Not Set';
        if (status && status.clientIdSet && !status.clientSecretSet) msg = 'Client Secret Missing';
        else if (status && !status.clientIdSet && status.clientSecretSet) msg = 'Client ID Missing';
        credsStatusText.text(msg).css('color', 'coral');
        areServerCredentialsSet = false;
        loginButton.prop('disabled', true).attr('title', 'Spotify credentials not set on server.');
    }
     updateAuthStatusUI(isAuthenticated, areServerCredentialsSet);
}

function updateAuthStatusUI(loggedIn, serverCredsAreSet = areServerCredentialsSet) {
    const statusText = $('#moodmusic-status');
    const loginButton = $('#moodmusic-login-button');
    if (!statusText.length || !loginButton.length) { console.warn(`${LOG_PREFIX} [updateAuthStatusUI] UI elements not found.`); return; }

    isAuthenticated = loggedIn;

    if (!serverCredsAreSet) {
        statusText.text('Configure Credentials').css('color', 'orange');
        loginButton.hide();
    } else if (loggedIn) {
        statusText.text('Logged In').css('color', 'lightgreen');
        loginButton.hide();
    } else {
        statusText.text('Not Logged In').css('color', 'coral');
        loginButton.show().prop('disabled', false);
    }

    const previousIsAuthenticated = window.moodMusicPreviousIsAuthenticated || false;
    window.moodMusicPreviousIsAuthenticated = loggedIn;

    if (previousIsAuthenticated !== loggedIn) {
        console.log(`${LOG_PREFIX} Auth state changed from ${previousIsAuthenticated} to: ${loggedIn}`);
        if (!loggedIn && isPollingPlayback) {
            stopPlaybackPolling();
        } else if (loggedIn && !isPollingPlayback && isInitialized && isExtensionActive && !pollingIntervalId && areServerCredentialsSet) {
            console.log(`${LOG_PREFIX} Starting polling interval after login or credential setup.`);
            if (pollingIntervalId) clearInterval(pollingIntervalId); // Clear just in case
            pollingIntervalId = setInterval(pollPlaybackState, POLLING_INTERVAL_MS);
        }
    }
    isAuthenticated = loggedIn;
}


function updateToggleButtonUI() {
    const $button = $('#moodmusic-toggle-button');
    if (!$button.length) return;
    if (isExtensionActive) {
        $button.html('<i class="fa-solid fa-pause"></i> Pause Music').removeClass('success_button').addClass('menu_button');
    } else {
        $button.html('<i class="fa-solid fa-play"></i> Resume Music').removeClass('menu_button').addClass('success_button');
    }
}

// API Calls to Server Plugin
async function loadCredentialsStatus() {
    try {
        const response = await fetch(`${PLUGIN_API_BASE}/config`, { method: 'GET' });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        updateCredentialsStatusUI(data);
        console.log(`${LOG_PREFIX} Credential status loaded:`, data);
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed to load credential status:`, error);
        updateCredentialsStatusUI({ clientIdSet: false, clientSecretSet: false });
        callPopup("Failed to load MoodMusic credential status.", "error");
    }
}

async function saveSpotifyCredentials() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [saveSpotifyCredentials]`;
    const clientId = $('#moodmusic-client-id').val();
    const clientSecret = $('#moodmusic-client-secret').val();

    if (!clientId || !clientSecret) {
        callPopup("Client ID and Client Secret are required.", "error");
        return;
    }

    try {
        const response = await fetch(`${PLUGIN_API_BASE}/config`, {
            method: 'POST',
            headers: getApiHeaders(), // This now works correctly
            body: JSON.stringify({ clientId, clientSecret }),
        });

        if (!response.ok) {
            let errorText = `Server error: ${response.status} ${response.statusText}`;
            try {
                const errorJson = await response.json();
                if (errorJson && errorJson.message) {
                    errorText = errorJson.message;
                }
            } catch (e) {
                if (response.status === 403) {
                    errorText = 'Forbidden. CSRF token seems to be invalid. Please refresh the page.';
                }
            }
            throw new Error(errorText);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error(data.message || 'Operation failed with an unspecified error.');
        }

        callPopup("Spotify credentials saved. Any existing login was cleared.", "success");
        console.log(`${LOG_PREFIX_FUNC} Credentials saved.`);
        $('#moodmusic-client-secret').val('');
        await loadCredentialsStatus();
        await checkAuthStatus();
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} Error saving credentials:`, error);
        callPopup(`Error saving credentials: ${error.message}`, "error");
    }
}


async function checkAuthStatus() {
    try {
        const response = await fetch(`${PLUGIN_API_BASE}/auth/status`, { method: 'GET' });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        areServerCredentialsSet = data.credentialsSet;
        updateAuthStatusUI(data.loggedIn, data.credentialsSet);
    } catch (error) {
        console.error(`${LOG_PREFIX} checkAuthStatus failed:`, error);
        updateAuthStatusUI(false, areServerCredentialsSet);
    }
}

async function triggerSpotifyLogin() {
    if (!areServerCredentialsSet) {
        callPopup("Cannot login: Spotify credentials are not configured.", "error");
        return;
    }
    try {
        const loginUrl = `${PLUGIN_API_BASE}/auth/login`;
        const popupWidth = 600, popupHeight = 700;
        const left = (window.screen.width / 2) - (popupWidth / 2);
        const top = (window.screen.height / 2) - (popupHeight / 2);
        const popup = window.open(loginUrl, 'SpotifyLogin', `width=${popupWidth},height=${popupHeight},left=${left},top=${top},scrollbars=yes`);

        const checkPopupClosed = setInterval(async () => {
            if (!popup || popup.closed) {
                clearInterval(checkPopupClosed);
                console.log(`${LOG_PREFIX} Login popup closed. Re-checking auth...`);
                setTimeout(checkAuthStatus, 1500);
            }
        }, 1000);
    } catch (error) {
        console.error(`${LOG_PREFIX} Error in triggerSpotifyLogin:`, error);
        callPopup(`Login error: ${error.message}`, "error");
    }
}

async function getPlaybackState() {
    if (!isAuthenticated) return null;
    try {
        const response = await fetch(`${PLUGIN_API_BASE}/playback/state`, { method: 'GET' });
        if (response.status === 401) {
            console.warn(`${LOG_PREFIX} Got 401. Re-checking auth.`); await checkAuthStatus(); return null;
        }
        if (!response.ok) { console.error(`${LOG_PREFIX} HTTP error getting playback state: ${response.status}`); return null; }
        return await response.json();
    } catch (error) { console.error(`${LOG_PREFIX} Network error getting playback state:`, error); return null; }
}

function startPlaybackPolling(trackUri) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [startPlaybackPolling]`;
    if (!isExtensionActive) { console.log(`${LOG_PREFIX_FUNC} Not starting: extension paused.`); return; }
    if (isPollingPlayback) return;
    if (!isAuthenticated || !trackUri) return;
    console.log(`${LOG_PREFIX_FUNC} Starting polling for URI: ${trackUri}`);
    currentlyPlayingTrackUri = trackUri; isPollingPlayback = true;
}

function stopPlaybackPolling() {
    if (!isPollingPlayback) return;
    console.log(`${LOG_PREFIX} [stopPlaybackPolling] Stopping polling.`);
    isPollingPlayback = false; currentlyPlayingTrackUri = null;
}

async function pollPlaybackState() {
    if (!isExtensionActive || !isAuthenticated) return;

    const state = await getPlaybackState();
    if (!state) {
        if (isPollingPlayback) {
            console.warn(`${LOG_PREFIX} Polling stopped due to state error.`);
            stopPlaybackPolling();
            lastPlaybackStopTime = Date.now();
            if (currentPresetRestorationRequired) await restoreOriginalPreset();
        }
        return;
    }

    const isTargetTrackActive = isPollingPlayback && state.is_playing && state.item?.uri === currentlyPlayingTrackUri;

    if (isTargetTrackActive) {
        lastPlaybackStopTime = 0; // Reset timer if our track is playing
    } else {
        if (isPollingPlayback) { // Our track just stopped
            console.log(`${LOG_PREFIX} Target track stopped/ended.`);
            stopPlaybackPolling();
            lastPlaybackStopTime = Date.now();
            await restoreOriginalPreset(); // Restore preset right away
            // Trigger next analysis after a short delay
            setTimeout(() => {
                if (isExtensionActive && !isAnalysisInProgress && isAuthenticated) triggerMoodAnalysisAndPlay();
            }, 500);
        } else if (!state.is_playing) { // Nothing is playing
            if (lastPlaybackStopTime === 0) lastPlaybackStopTime = Date.now();
            const timeSinceStop = Date.now() - lastPlaybackStopTime;
            if (timeSinceStop >= MOOD_ANALYSIS_TRIGGER_THRESHOLD_MS && !isAnalysisInProgress) {
                 console.log(`${LOG_PREFIX} Inactivity threshold passed. Triggering mood analysis.`);
                 lastPlaybackStopTime = Date.now(); // Reset timer
                 triggerMoodAnalysisAndPlay();
            }
        } else { // Unrelated music is playing
             lastPlaybackStopTime = Date.now(); // Keep pushing back the timer
        }
    }
}

// --- Preset Management ---
function findAndStorePresetDropdown() {
    const dropdownId = '#settings_preset_openai';
    const $foundDropdown = $(dropdownId);
    if ($foundDropdown.length) {
        $presetDropdown = $foundDropdown;
    } else {
        console.error(`${LOG_PREFIX} Could NOT find preset dropdown element: ${dropdownId}.`);
    }
}

function getCurrentPresetNameFromUi() {
    if (!$presetDropdown || !$presetDropdown.length) findAndStorePresetDropdown();
    if (!$presetDropdown || !$presetDropdown.length) {
        console.error(`${LOG_PREFIX} Dropdown object is invalid. Cannot get current preset.`);
        return null;
    }
    return $presetDropdown.find('option:selected').text().trim();
}

async function setPresetViaUi(presetName) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [setPresetViaUi]`;
    if (!$presetDropdown || !$presetDropdown.length) {
        console.error(`${LOG_PREFIX_FUNC} Cannot find preset dropdown. Aborting switch.`);
        return false;
    }
    const $targetOption = $presetDropdown.find('option').filter(function() {
        return $(this).text().trim() === presetName;
    });

    if ($targetOption.length) {
        const targetValue = $targetOption.val();
        if ($presetDropdown.val() === targetValue) {
            console.log(`${LOG_PREFIX_FUNC} Preset "${presetName}" is already selected.`);
            return true;
        }
        $presetDropdown.val(targetValue).trigger('change');
        await new Promise(resolve => setTimeout(resolve, 200)); // UI reaction time
        if ($presetDropdown.val() === targetValue) {
            console.log(`${LOG_PREFIX_FUNC} Successfully switched to preset "${presetName}".`);
            return true;
        } else {
            console.error(`${LOG_PREFIX_FUNC} Verification failed after attempting to set preset "${presetName}".`);
            return false;
        }
    } else {
        console.error(`${LOG_PREFIX_FUNC} Could not find preset option: "${presetName}".`);
        return false;
    }
}

// OPTIMIZED: Centralized preset restoration logic
async function restoreOriginalPreset() {
    if (currentPresetRestorationRequired && originalPresetName) {
        console.log(`${LOG_PREFIX} Restoring original preset: ${originalPresetName}`);
        const restored = await setPresetViaUi(originalPresetName);
        if (!restored) {
             console.error(`${LOG_PREFIX} CRITICAL: FAILED TO RESTORE ORIGINAL PRESET "${originalPresetName}".`);
             callPopup(`MoodMusic: CRITICAL! Failed to restore preset. Please check manually.`, "error");
        }
    } else if (currentPresetRestorationRequired && !originalPresetName) {
        console.error(`${LOG_PREFIX} Preset restoration required, but original preset name was not captured.`);
        callPopup(`MoodMusic: Error! Switched to ${MUSIC_PRESET_NAME} but original preset was unknown. Please check preset settings.`, "warning");
    }
    // Reset flags regardless of outcome
    currentPresetRestorationRequired = false;
    originalPresetName = null;
}

// --- AI Interaction ---
async function getMusicSuggestionFromAI(chatHistorySnippet) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [getMusicSuggestionFromAI]`;
    console.log(`${LOG_PREFIX_FUNC} Requesting music suggestion...`);

    const apiType = $('#main_api').val();
    if (!apiType?.length) {
        callPopup("MoodMusic: Could not determine API type.", "error");
        return null;
    }

    const switched = await setPresetViaUi(MUSIC_PRESET_NAME);
    if (!switched) {
        console.error(`${LOG_PREFIX_FUNC} Failed to switch to preset "${MUSIC_PRESET_NAME}". Skipping AI call.`);
        return null;
    }
    currentPresetRestorationRequired = true;

    try {
        const chatCompletionApis = ['openai', 'anthropic'];
        const textCompletionApis = ['textgenerationwebui', 'kobold', 'novel', 'koboldhorde'];
        let aiResponseText = null;

        if (chatCompletionApis.includes(apiType)) {
            console.log(`${LOG_PREFIX_FUNC} Using 'generateQuietPrompt' for chat completion API: ${apiType}.`);
            aiResponseText = await generateQuietPrompt(chatHistorySnippet, false, true, { source: 'moodmusic-chat' });
        } else if (textCompletionApis.includes(apiType)) {
            console.log(`${LOG_PREFIX_FUNC} Using 'generateRaw' for text completion API: ${apiType}.`);
            const prompt = `Based on the following chat, suggest a song (title and artist) that fits the mood. Respond only with 'Title: <song title>' and on a new line 'Artist: <song artist>'.\n\nChat Excerpt:\n${chatHistorySnippet}\n\nTitle:\nArtist:`;
            
            aiResponseText = await generateRaw(
                prompt,
                null, // 2. api_override: null uses the UI's selected API
                150,  // 3. tokenCount
                null, null, null, null, null, null, null, null, null, null, // 4-13. various generation params
                MUSIC_PRESET_NAME, // 14. gen_settings_preset_name
                null, // 15. generate_settings_override
                { source: 'moodmusic-text' } // 16. quiet_prompt_params
            );
        } else {
            console.warn(`${LOG_PREFIX_FUNC} API type '${apiType}' not in explicit lists. Defaulting to generateQuietPrompt.`);
            aiResponseText = await generateQuietPrompt(chatHistorySnippet, false, true, { source: 'moodmusic-unknown-api-fallback' });
        }

        if (!aiResponseText || typeof aiResponseText !== 'string' || aiResponseText.trim() === '') {
            throw new Error("AI call returned an empty or invalid response.");
        }
        return aiResponseText.trim();
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} Error during AI music suggestion:`, error);
        callPopup(`MoodMusic: AI suggestion failed: ${error.message}`, "error");
        return null;
    }
}


function parseMusicFromAiResponse(aiResponseText) {
    if (!aiResponseText || typeof aiResponseText !== 'string') return null;
    const titleMatch = aiResponseText.match(/Title:\s*(.*)/i);
    const artistMatch = aiResponseText.match(/Artist:\s*(.*)/i);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const artist = artistMatch ? artistMatch[1].trim() : null;
    if (title) return { title, artist };
    console.warn(`${LOG_PREFIX} Could not parse Title from AI response: "${aiResponseText}"`);
    return null;
}

async function requestPlaySong(suggestion) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [requestPlaySong]`;
    if (!isAuthenticated) { callPopup("Cannot play: Not logged into Spotify.", "error"); return false; }
    if (!suggestion || !suggestion.title) { console.error(`${LOG_PREFIX_FUNC} Invalid suggestion.`); return false; }

    try {
        const response = await fetch(`${PLUGIN_API_BASE}/play`, {
            method: 'POST',
            headers: getApiHeaders(), // This now works correctly
            body: JSON.stringify({ suggestion: suggestion })
        });

        const data = await response.json();
        if (!response.ok) {
            let errorMsg = data.message || `Play request failed (HTTP ${response.status})`;
            callPopup(`MoodMusic Error: ${errorMsg}`, 'error');
            if (data.needsLogin) await checkAuthStatus();
            if (data.needsConfiguration) await loadCredentialsStatus();
            return false;
        }

        console.log(`${LOG_PREFIX_FUNC} Play request successful: ${data.message}`);
        if (data.success && data.trackUri) startPlaybackPolling(data.trackUri);
        return true;
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} Network/other error during play request:`, error);
        callPopup(`MoodMusic Error: ${error.message || 'Request failed'}`, 'error');
        return false;
    }
}

async function triggerMoodAnalysisAndPlay() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [triggerMoodAnalysisAndPlay]`;
    if (isAnalysisInProgress || !isExtensionActive || !isAuthenticated) {
        console.log(`${LOG_PREFIX_FUNC} Aborted (Analysis running: ${isAnalysisInProgress}, Active: ${isExtensionActive}, Auth: ${isAuthenticated})`);
        return;
    }

    console.log(`${LOG_PREFIX_FUNC} Starting mood analysis sequence...`);
    isAnalysisInProgress = true;
    currentPresetRestorationRequired = false;
    originalPresetName = null;

    try {
        const context = getContext();
        if (!context?.chat?.length) {
            console.warn(`${LOG_PREFIX_FUNC} No chat history available for analysis.`);
            return;
        }

        const history = context.chat.slice(-HISTORY_FOR_MOOD_ANALYSIS);
        const chatHistorySnippet = history.map(msg => `${msg.is_user ? 'User' : 'Character'}: ${msg.mes}`).join('\n');

        originalPresetName = getCurrentPresetNameFromUi();
        if (!originalPresetName) {
            console.error(`${LOG_PREFIX_FUNC} Could not determine original preset name. Restoration may fail.`);
        } else {
            console.log(`${LOG_PREFIX_FUNC} Stored original preset: ${originalPresetName}`);
        }

        const aiResponseText = await getMusicSuggestionFromAI(chatHistorySnippet);
        if (aiResponseText) {
            const suggestion = parseMusicFromAiResponse(aiResponseText);
            if (suggestion) await requestPlaySong(suggestion);
        } else {
            console.error(`${LOG_PREFIX_FUNC} Failed to get a valid suggestion from AI.`);
        }
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} UNEXPECTED ERROR in analysis sequence:`, error);
    } finally {
        await restoreOriginalPreset();
        isAnalysisInProgress = false;
        console.log(`${LOG_PREFIX_FUNC} Mood analysis process finished.`);
    }
}

function toggleExtensionActiveState() {
    isExtensionActive = !isExtensionActive;
    updateToggleButtonUI();
    if (isExtensionActive) {
        console.log(`${LOG_PREFIX} Extension Resumed.`);
        if (!pollingIntervalId && isAuthenticated) {
            pollingIntervalId = setInterval(pollPlaybackState, POLLING_INTERVAL_MS);
            pollPlaybackState();
        }
    } else {
        console.log(`${LOG_PREFIX} Extension Paused.`);
        stopPlaybackPolling();
        if (pollingIntervalId) { clearInterval(pollingIntervalId); pollingIntervalId = null; }
        if (isAnalysisInProgress) restoreOriginalPreset();
        isAnalysisInProgress = false;
    }
}

async function initializeExtension() {
    console.log(`${LOG_PREFIX} Initializing...`);
    if (isInitialized) return;

    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
        $('#extensions_settings')
            .on('click', '#moodmusic-save-creds-button', saveSpotifyCredentials)
            .on('click', '#moodmusic-login-button', triggerSpotifyLogin)
            .on('click', '#moodmusic-toggle-button', toggleExtensionActiveState);

        updateToggleButtonUI();
        findAndStorePresetDropdown();

        await loadCredentialsStatus();
        await checkAuthStatus();

        if (isExtensionActive && isAuthenticated) {
            if (pollingIntervalId) clearInterval(pollingIntervalId);
            pollingIntervalId = setInterval(pollPlaybackState, POLLING_INTERVAL_MS);
        }
        isInitialized = true;
        console.log(`${LOG_PREFIX} Initialization COMPLETE.`);
    } catch (error) {
        console.error(`${LOG_PREFIX} Initialization FAILED:`, error);
        $("#extensions_settings").append(`<div class="error" style="color:red;"><b>MoodMusic INIT FAILED:</b> ${error.message}. Check Console.</div>`);
    }
}

$(document).ready(() => {
    setTimeout(initializeExtension, 1500);
});