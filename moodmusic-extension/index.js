// --- START OF FILE index.js ---

import { getContext } from '../../../extensions.js';
import { callPopup, eventSource, event_types, generateQuietPrompt } from '../../../../script.js';

const extensionName = "moodmusic-extension";
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

    const authStateChanged = isAuthenticated !== loggedIn; // Compare with actual new loggedIn state
    // Let's re-evaluate the global isAuthenticated based on the passed `loggedIn` argument
    // as `isAuthenticated` might be stale when this function is called during credential changes.
    const previousIsAuthenticated = window.moodMusicPreviousIsAuthenticated || false; // Keep track of previous state
    window.moodMusicPreviousIsAuthenticated = loggedIn;


    if (previousIsAuthenticated !== loggedIn) {
        console.log(`${LOG_PREFIX} *** Auth state changed from ${previousIsAuthenticated} to: ${loggedIn}`);
        if (!loggedIn && isPollingPlayback) {
            stopPlaybackPolling();
        } else if (loggedIn && !isPollingPlayback && isInitialized && isExtensionActive && !pollingIntervalId && areServerCredentialsSet) {
            console.log(`${LOG_PREFIX} Starting polling interval after login or credential setup.`);
            if (pollingIntervalId) clearInterval(pollingIntervalId); // Clear just in case
            pollingIntervalId = setInterval(pollPlaybackState, POLLING_INTERVAL_MS);
        }
    }
    isAuthenticated = loggedIn; // Update global state definitively
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
    console.log(`${LOG_PREFIX} loadCredentialsStatus START`);
    try {
        const response = await fetch(`${PLUGIN_API_BASE}/config`, { method: 'GET' });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        updateCredentialsStatusUI(data); // This will also call updateAuthStatusUI
        console.log(`${LOG_PREFIX} Credential status loaded:`, data);
    } catch (error) {
        console.error(`${LOG_PREFIX} loadCredentialsStatus CATCH block:`, error);
        updateCredentialsStatusUI({ clientIdSet: false, clientSecretSet: false });
        callPopup("Failed to load MoodMusic credential status.", "error");
    }
    console.log(`${LOG_PREFIX} loadCredentialsStatus END`);
}

async function saveSpotifyCredentials() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [saveSpotifyCredentials]`;
    console.log(`${LOG_PREFIX_FUNC} START`);
    const clientId = $('#moodmusic-client-id').val();
    const clientSecret = $('#moodmusic-client-secret').val();

    if (!clientId || !clientSecret) {
        callPopup("Client ID and Client Secret are required.", "error");
        console.warn(`${LOG_PREFIX_FUNC} Client ID or Secret is empty.`);
        return;
    }

    try {
        const headers = { 'Content-Type': 'application/json' };
        const response = await fetch(`${PLUGIN_API_BASE}/config`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ clientId, clientSecret }),
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.message || `HTTP error! status: ${response.status}`);
        }
        callPopup("Spotify credentials saved. Any existing login was cleared.", "success");
        console.log(`${LOG_PREFIX_FUNC} Credentials saved.`);
        $('#moodmusic-client-secret').val('');
        await loadCredentialsStatus(); // This updates areServerCredentialsSet
        await checkAuthStatus();       // This re-checks login status
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} CATCH block:`, error);
        callPopup(`Error saving credentials: ${error.message}`, "error");
    }
    console.log(`${LOG_PREFIX_FUNC} END`);
}


async function checkAuthStatus() {
    console.log(`${LOG_PREFIX} checkAuthStatus START`);
    try {
        if (!$('#moodmusic-creds-status').length) {
            console.warn(`${LOG_PREFIX} [checkAuthStatus] Creds UI not ready, deferring.`);
            setTimeout(checkAuthStatus, 300);
            return;
        }
        
        const configResponse = await fetch(`${PLUGIN_API_BASE}/config`, { method: 'GET' });
        if (!configResponse.ok) throw new Error(`Config check failed: ${configResponse.status}`);
        const configData = await configResponse.json();
        // updateCredentialsStatusUI(configData); // This is called by loadCredentialsStatus. Re-calling might be redundant if loadCredentialsStatus is always called first.
                                              // Let's keep it simple: loadCredentialsStatus updates cred UI, checkAuthStatus updates auth UI.

        areServerCredentialsSet = configData.clientIdSet && configData.clientSecretSet; // Update global state

        if (!areServerCredentialsSet) {
            console.log(`${LOG_PREFIX} Credentials not set on server. Auth check skipped for Spotify login.`);
            updateAuthStatusUI(false, false); // Logged out, creds not set
            return;
        }

        const headers = { 'Content-Type': 'application/json' };
        const response = await fetch(`${PLUGIN_API_BASE}/auth/status`, { method: 'GET', headers: headers });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`${LOG_PREFIX} checkAuthStatus HTTP ${response.status}`, errorText);
            updateAuthStatusUI(false, true); // Logged out, but creds are set
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json(); // data = { loggedIn: bool, credentialsSet: bool }
        updateAuthStatusUI(data.loggedIn, data.credentialsSet);
    } catch (error) {
        console.error(`${LOG_PREFIX} checkAuthStatus CATCH block:`, error);
        updateAuthStatusUI(false, areServerCredentialsSet); // Use current knowledge of cred status
    }
    console.log(`${LOG_PREFIX} checkAuthStatus END`);
}

async function triggerSpotifyLogin() {
    console.log('!!! moodmusic-login-button CLICKED - triggerSpotifyLogin START !!!');
    if (!areServerCredentialsSet) {
        callPopup("Cannot login: Spotify credentials are not configured.", "error");
        console.warn(`${LOG_PREFIX} [triggerSpotifyLogin] Aborted: Server credentials not set.`);
        return;
    }
    try {
        const loginUrl = `${PLUGIN_API_BASE}/auth/login`;
        const popupWidth = 600; const popupHeight = 700;
        const left = (window.screen.width / 2) - (popupWidth / 2);
        const top = (window.screen.height / 2) - (popupHeight / 2);
        const popup = window.open(loginUrl, 'SpotifyLogin', `width=${popupWidth},height=${popupHeight},left=${left},top=${top},scrollbars=yes`);
        if (!popup || popup.closed || typeof popup.closed == 'undefined') {
            console.error(`${LOG_PREFIX} Failed to open login window.`);
            callPopup("Failed to open Spotify login window. Allow popups.", "error");
            return;
        }
        const checkPopupClosed = setInterval(async () => {
            let closed = false; try { closed = popup.closed; } catch (e) { closed = !popup || popup.closed; }
            if (closed) {
                clearInterval(checkPopupClosed);
                console.log(`${LOG_PREFIX} Login popup closed. Re-checking auth...`);
                setTimeout(checkAuthStatus, 1500);
            }
        }, 1000);
    } catch (error) {
        console.error(`${LOG_PREFIX} Error in triggerSpotifyLogin:`, error);
        callPopup(`Login error: ${error.message}`, "error");
    }
    console.log(`${LOG_PREFIX} triggerSpotifyLogin END`);
}

async function getPlaybackState() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [getPlaybackState]`;
    if (!areServerCredentialsSet) return null;
    if (!isAuthenticated) { return null; }
    try {
        const headers = { 'Content-Type': 'application/json' };
        const response = await fetch(`${PLUGIN_API_BASE}/playback/state`, { method: 'GET', headers: headers });
        if (response.status === 400) {
            const errorData = await response.json();
            if (errorData.needsConfiguration) {
                console.warn(`${LOG_PREFIX_FUNC} Server indicates credentials not configured. Re-checking.`);
                await loadCredentialsStatus(); await checkAuthStatus(); return null;
            }
        }
        if (response.status === 401) {
            console.warn(`${LOG_PREFIX_FUNC} Got 401. Re-checking auth.`); await checkAuthStatus(); return null;
        }
        if (!response.ok) { console.error(`${LOG_PREFIX_FUNC} HTTP error: ${response.status}`); return null; }
        return await response.json();
    } catch (error) { console.error(`${LOG_PREFIX_FUNC} Network error:`, error); return null; }
}

function startPlaybackPolling(trackUri) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [startPlaybackPolling]`;
    if (!isExtensionActive) { console.log(`${LOG_PREFIX_FUNC} Not starting: extension paused.`); return; }
    if (isPollingPlayback) { if (currentlyPlayingTrackUri === trackUri) return; stopPlaybackPolling(); }
    if (!isAuthenticated || !trackUri || !areServerCredentialsSet) {
        console.warn(`${LOG_PREFIX_FUNC} Cannot start: Auth=${isAuthenticated}, URI=${trackUri}, CredsSet=${areServerCredentialsSet}`); return;
    }
    console.log(`${LOG_PREFIX_FUNC} Starting polling for URI: ${trackUri}`);
    currentlyPlayingTrackUri = trackUri; isPollingPlayback = true;
}

function stopPlaybackPolling() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [stopPlaybackPolling]`;
    if (!isPollingPlayback) { return; }
    console.log(`${LOG_PREFIX_FUNC} Stopping polling for URI: ${currentlyPlayingTrackUri}`);
    isPollingPlayback = false; currentlyPlayingTrackUri = null;
}

async function pollPlaybackState() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [pollPlaybackState]`;
    if (!isExtensionActive) return;
    if (!areServerCredentialsSet) {
        if (pollingIntervalId) { clearInterval(pollingIntervalId); pollingIntervalId = null; }
        await loadCredentialsStatus(); await checkAuthStatus(); return;
    }
    if (!isAuthenticated) { if (isPollingPlayback) stopPlaybackPolling(); return; }

    const state = await getPlaybackState();
    if (!state) {
        if (isPollingPlayback) {
            console.warn(`${LOG_PREFIX_FUNC} Polling active, stopping due to state error.`);
            stopPlaybackPolling(); lastPlaybackStopTime = Date.now();
            if (currentPresetRestorationRequired && originalPresetName) {
                console.warn(`${LOG_PREFIX_FUNC} Restoring preset after state error: ${originalPresetName}`);
                await setPresetViaUi(originalPresetName);
                currentPresetRestorationRequired = false; originalPresetName = null;
            }
        }
        return;
    }

    const isTargetTrackActive = isPollingPlayback && state.is_playing && state.item?.uri === currentlyPlayingTrackUri;
    if (isTargetTrackActive) { lastPlaybackStopTime = 0; }
    else {
        if (isPollingPlayback) { // Target track stopped
            console.log(`${LOG_PREFIX_FUNC} Target track stopped/ended.`);
            if (lastPlaybackStopTime === 0) lastPlaybackStopTime = Date.now();
            stopPlaybackPolling();
            let restoredPreset = false;
            if (currentPresetRestorationRequired && originalPresetName) {
                restoredPreset = await setPresetViaUi(originalPresetName);
            }
            if (currentPresetRestorationRequired && !restoredPreset) console.warn(`${LOG_PREFIX_FUNC} Failed to restore preset after song end.`);
            currentPresetRestorationRequired = false; originalPresetName = null;
            setTimeout(() => {
                if (isExtensionActive && !isAnalysisInProgress && isAuthenticated && areServerCredentialsSet) triggerMoodAnalysisAndPlay();
            }, 500);
        }
        else if (!isPollingPlayback && !state.is_playing) { // Nothing playing, not polling for specific track
             if (lastPlaybackStopTime === 0) lastPlaybackStopTime = Date.now();
             const timeSinceStop = Date.now() - lastPlaybackStopTime;
             if (timeSinceStop >= MOOD_ANALYSIS_TRIGGER_THRESHOLD_MS && !isAnalysisInProgress && isAuthenticated && areServerCredentialsSet) {
                  console.log(`${LOG_PREFIX_FUNC} Threshold passed. Triggering mood analysis.`);
                  lastPlaybackStopTime = Date.now(); triggerMoodAnalysisAndPlay();
             }
        }
        else if (!isPollingPlayback && state.is_playing) { // Unrelated music playing
             lastPlaybackStopTime = Date.now();
        }
    }
}

// --- Preset Management ---
function findAndStorePresetDropdown() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [findAndStorePresetDropdown]`;
    const dropdownId = '#settings_preset_openai'; // This is the ID for the main preset dropdown in SillyTavern
    console.log(`${LOG_PREFIX_FUNC} Attempting to find dropdown with ID: ${dropdownId}`);
    const $foundDropdown = $(dropdownId); // Use a local variable first

    if ($foundDropdown.length) {
        console.log(`${LOG_PREFIX_FUNC} Successfully found dropdown element. It has ${$foundDropdown.find('option').length} options.`);
        $presetDropdown = $foundDropdown; // Assign to global cache if found
    } else {
        console.error(`${LOG_PREFIX_FUNC} Could NOT find dropdown element with ID: ${dropdownId}. Global $presetDropdown will remain as is (or null).`);
        // Don't set to null if it was previously found and is now missing, that might be a temporary DOM issue.
        // Only set to null if it was never found or if we explicitly want to reset.
        // For now, if it's not found, the existing $presetDropdown (if any) is kept.
        // If $presetDropdown was null, it stays null.
    }
}

function getCurrentPresetNameFromUi() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [getCurrentPresetNameFromUi]`;
    findAndStorePresetDropdown(); // Attempt to find/update $presetDropdown cache

    if (!$presetDropdown || !$presetDropdown.length) {
        console.error(`${LOG_PREFIX_FUNC} Dropdown object ($presetDropdown) is invalid or not found. Cannot get current preset.`);
        return null;
    }

    const $selectedOption = $presetDropdown.find('option:selected');
    if (!$selectedOption.length) {
        console.warn(`${LOG_PREFIX_FUNC} Dropdown found, but no <option> is selected.`);
        let options = [];
        $presetDropdown.find('option').each(function() { options.push(`'${$(this).text()}' (val: ${$(this).val()})`); });
        console.log(`${LOG_PREFIX_FUNC} Available options in dropdown: [${options.join(', ')}]`);
        return null;
    }

    const selectedOptionText = $selectedOption.text().trim();
    if (selectedOptionText) {
        console.log(`${LOG_PREFIX_FUNC} Found selected option text: "${selectedOptionText}"`);
        return selectedOptionText;
    } else {
        console.warn(`${LOG_PREFIX_FUNC} Dropdown found, an option is selected (val: "${$selectedOption.val()}"), but its text is empty.`);
        return null; // Or consider returning value if text is optional, but text is usually key.
    }
}

async function setPresetViaUi(presetName) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [setPresetViaUi]`;
    console.log(`${LOG_PREFIX_FUNC} Attempting switch to: "${presetName}"`);
    findAndStorePresetDropdown(); // Ensure $presetDropdown is fresh

    if (!$presetDropdown || !$presetDropdown.length) {
        console.error(`${LOG_PREFIX_FUNC} Cannot find preset dropdown. Aborting switch to "${presetName}".`);
        if (currentPresetRestorationRequired) { currentPresetRestorationRequired = false; originalPresetName = null; }
        return false;
    }

    let targetOptionValue = null; let found = false;
    $presetDropdown.find('option').each(function() {
        const $option = $(this);
        if ($option.text().trim() === presetName) {
            targetOptionValue = $option.val(); found = true; return false;
        }
    });

    if (found && targetOptionValue !== null) {
        if ($presetDropdown.val() === targetOptionValue) {
            console.log(`${LOG_PREFIX_FUNC} Preset "${presetName}" already selected.`); return true;
        }
        console.log(`${LOG_PREFIX_FUNC} Setting preset to "${presetName}" (value ${targetOptionValue}).`);
        $presetDropdown.val(targetOptionValue).trigger('change');
        await new Promise(resolve => setTimeout(resolve, 200)); // Give UI time to react
        if ($presetDropdown.val() === targetOptionValue) {
            console.log(`${LOG_PREFIX_FUNC} Successfully selected "${presetName}".`); return true;
        } else {
            console.error(`${LOG_PREFIX_FUNC} Verification failed! Tried to set "${presetName}", but current is "${$presetDropdown.find('option:selected').text().trim()}".`);
            if (currentPresetRestorationRequired && originalPresetName) {
                console.warn(`${LOG_PREFIX_FUNC} Attempting auto-restore to ${originalPresetName}.`);
                await setPresetViaUi(originalPresetName);
            }
            return false;
        }
    } else {
        console.error(`${LOG_PREFIX_FUNC} Could not find option: "${presetName}". Available: [${$presetDropdown.find('option').map((i,el) => $(el).text().trim()).get().join(', ')}]`);
        if (currentPresetRestorationRequired && originalPresetName) {
            console.warn(`${LOG_PREFIX_FUNC} Attempting auto-restore to ${originalPresetName}.`);
            await setPresetViaUi(originalPresetName);
        }
        return false;
    }
}

// --- AI Interaction ---
async function getMusicSuggestionFromAI(chatHistorySnippet) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [getMusicSuggestionFromAI]`;
    console.log(`${LOG_PREFIX_FUNC} Requesting music suggestion using preset "${MUSIC_PRESET_NAME}"...`);

    const switched = await setPresetViaUi(MUSIC_PRESET_NAME);
    if (!switched) {
        console.error(`${LOG_PREFIX_FUNC} Failed switch to preset "${MUSIC_PRESET_NAME}". Skipping AI call.`);
        currentPresetRestorationRequired = false; originalPresetName = null;
        return null;
    }
    currentPresetRestorationRequired = true; // Flag that restoration is needed

    try {
        console.warn(`${LOG_PREFIX_FUNC} IMPORTANT: Ensure "${MUSIC_PRESET_NAME}" preset has correct System Prompt for music suggestions.`);
        console.log(`${LOG_PREFIX_FUNC} Calling generateQuietPrompt...`);
        const aiResponseText = await generateQuietPrompt(chatHistorySnippet, false, true);
        console.log(`${LOG_PREFIX_FUNC} generateQuietPrompt returned: "${aiResponseText}"`);
        if (!aiResponseText || typeof aiResponseText !== 'string' || aiResponseText.trim() === '') {
            throw new Error("generateQuietPrompt returned empty or invalid response.");
        }
        return aiResponseText.trim();
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} Error during generateQuietPrompt:`, error);
        return null;
    }
}
function parseMusicFromAiResponse(aiResponseText) { /* (No changes from before) */
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [parseMusicFromAiResponse]`; if (!aiResponseText || typeof aiResponseText !== 'string') { console.warn(`${LOG_PREFIX_FUNC} Invalid AI response text.`); return null; } const titleMatch = aiResponseText.match(/Title:\s*(.*)/i); const artistMatch = aiResponseText.match(/Artist:\s*(.*)/i); const title = titleMatch ? titleMatch[1].trim() : null; const artist = artistMatch ? artistMatch[1].trim() : null; if (title) { console.log(`${LOG_PREFIX_FUNC} Parsed - Title: "${title}", Artist: "${artist || 'N/A'}"`); return { title, artist }; } else { console.warn(`${LOG_PREFIX_FUNC} Could not parse Title from: "${aiResponseText}"`); return null; }
}

async function requestPlaySong(suggestion) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [requestPlaySong]`;
    if (!areServerCredentialsSet) { callPopup("Cannot play: Spotify creds not configured.", "error"); return false; }
    if (!isAuthenticated) { callPopup("Cannot play: Not logged into Spotify.", "error"); return false; }
    if (!suggestion || !suggestion.title) { console.error(`${LOG_PREFIX_FUNC} Invalid suggestion.`); return false; }

    try {
        const headers = { 'Content-Type': 'application/json' };
        const response = await fetch(`${PLUGIN_API_BASE}/play`, {
            method: 'POST', headers: headers, body: JSON.stringify({ suggestion: suggestion })
        });
        const data = await response.json();
        if (!response.ok) {
            let errorMsg = data.message || `Play fail (HTTP ${response.status})`;
            if (data.needsConfiguration) errorMsg = "Spotify credentials not set on server.";
            else if (data.needsLogin) errorMsg = "Spotify login required.";
            callPopup(`MoodMusic Error: ${errorMsg}`, 'error');
            if (response.status === 401 || data.needsLogin) await checkAuthStatus();
            if (data.needsConfiguration) await loadCredentialsStatus();
            return false;
        }
        console.log(`${LOG_PREFIX_FUNC} Play request successful: ${data.message}`);
        if (data.success && data.trackUri) startPlaybackPolling(data.trackUri);
        return true;
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} Network/other error:`, error);
        callPopup(`MoodMusic Error: ${error.message || 'Request failed'}`, 'error');
        return false;
    }
}

async function triggerMoodAnalysisAndPlay() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [triggerMoodAnalysisAndPlay]`;
    if (!isExtensionActive) { console.log(`${LOG_PREFIX_FUNC} Aborted: Paused.`); return; }
    if (isAnalysisInProgress) { console.log(`${LOG_PREFIX_FUNC} Aborted: Already running.`); return; }
    if (!areServerCredentialsSet) { callPopup("MoodMusic: Set Spotify credentials.", "warning"); return; }
    if (!isAuthenticated) { callPopup("MoodMusic: Login to Spotify.", "warning"); return; }

    console.log(`${LOG_PREFIX_FUNC} Starting mood analysis and play sequence...`);
    isAnalysisInProgress = true;

    try {
        const context = getContext();
        if (!context?.chat?.length) {
            console.warn(`${LOG_PREFIX_FUNC} No chat history.`);
        } else {
            const history = context.chat.slice(-HISTORY_FOR_MOOD_ANALYSIS);
            const chatHistorySnippet = history.map(msg => `${msg.is_user ? 'User' : 'Character'}: ${msg.mes}`).join('\n');

            // This is where the original error occurred.
            // getCurrentPresetNameFromUi internally calls findAndStorePresetDropdown()
            originalPresetName = getCurrentPresetNameFromUi(); // Line ~444 in previous version
            if (!originalPresetName) {
                console.error(`${LOG_PREFIX_FUNC} Could not determine original preset name. Aborting AI step.`); // Line ~445
                // No need to set currentPresetRestorationRequired to false here, it's not set yet.
            } else {
                console.log(`${LOG_PREFIX_FUNC} Stored original preset: ${originalPresetName}`);
                const aiResponseText = await getMusicSuggestionFromAI(chatHistorySnippet); // This sets currentPresetRestorationRequired

                if (currentPresetRestorationRequired && originalPresetName) { // Check if restoration is due
                    console.log(`${LOG_PREFIX_FUNC} Attempting to restore original preset: ${originalPresetName}`);
                    await setPresetViaUi(originalPresetName);
                } else if (currentPresetRestorationRequired && !originalPresetName){
                     console.warn(`${LOG_PREFIX_FUNC} Restoration flag set, but original name missing. Odd.`);
                }
                // currentPresetRestorationRequired = false; // Will be reset in finally

                if (aiResponseText) {
                    const suggestion = parseMusicFromAiResponse(aiResponseText);
                    if (suggestion) await requestPlaySong(suggestion);
                    else console.error(`${LOG_PREFIX_FUNC} Failed to parse suggestion: "${aiResponseText}"`);
                } else {
                    console.error(`${LOG_PREFIX_FUNC} Failed to get suggestion from AI.`);
                }
            }
        }
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} UNEXPECTED ERROR:`, error);
        if (originalPresetName) { // Check if we even got an original name
             console.warn(`${LOG_PREFIX_FUNC} Attempting emergency preset restore to "${originalPresetName}".`);
             await setPresetViaUi(originalPresetName);
        }
    } finally {
        isAnalysisInProgress = false;
        currentPresetRestorationRequired = false;
        originalPresetName = null; // Ensure this is cleared
        console.log(`${LOG_PREFIX_FUNC} Process finished. Flags reset.`);
    }
}

function toggleExtensionActiveState() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [toggleExtensionActiveState]`;
    isExtensionActive = !isExtensionActive; updateToggleButtonUI();
    if (isExtensionActive) {
        console.log(`${LOG_PREFIX_FUNC} Extension Resumed.`);
        if (!pollingIntervalId && areServerCredentialsSet && isAuthenticated) {
            console.log(`${LOG_PREFIX_FUNC} Starting polling interval.`);
            pollingIntervalId = setInterval(pollPlaybackState, POLLING_INTERVAL_MS);
            setTimeout(pollPlaybackState, 100);
        }
    } else {
        console.log(`${LOG_PREFIX_FUNC} Extension Paused.`);
        stopPlaybackPolling();
        if (pollingIntervalId) { clearInterval(pollingIntervalId); pollingIntervalId = null; }
        if (isAnalysisInProgress) { isAnalysisInProgress = false; }
        if (currentPresetRestorationRequired) { currentPresetRestorationRequired = false; originalPresetName = null; }
    }
}

async function initializeExtension() {
    console.log(`${LOG_PREFIX} Initialize START`);
    if (isInitialized) { console.warn(`${LOG_PREFIX} Already initialized.`); return; }
    try {
        console.log(`${LOG_PREFIX} Initialize: Loading settings HTML...`);
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
        $('#extensions_settings').on('click', '#moodmusic-save-creds-button', saveSpotifyCredentials);
        $('#extensions_settings').on('click', '#moodmusic-login-button', triggerSpotifyLogin);
        $('#extensions_settings').on('click', '#moodmusic-toggle-button', toggleExtensionActiveState);
        $('#moodmusic-creds-status').text('Checking...');
        $('#moodmusic-status').text('Checking...');
        updateToggleButtonUI();
        console.log(`${LOG_PREFIX} Settings HTML processed.`);

        await loadCredentialsStatus(); // Loads server cred status & updates UI
        await checkAuthStatus();       // Sets isAuthenticated based on creds & token
        findAndStorePresetDropdown(); // Initial attempt to find dropdown

        if (isExtensionActive && areServerCredentialsSet && isAuthenticated) {
            console.log(`${LOG_PREFIX} Init: Active, creds set, authenticated. Starting polling.`);
            if (pollingIntervalId) clearInterval(pollingIntervalId);
            pollingIntervalId = setInterval(pollPlaybackState, POLLING_INTERVAL_MS);
        } else {
            console.log(`${LOG_PREFIX} Init: Polling NOT started (Active: ${isExtensionActive}, Creds: ${areServerCredentialsSet}, Auth: ${isAuthenticated})`);
        }
        isInitialized = true;
        console.log(`${LOG_PREFIX} *** Client initialization COMPLETED. ***`);
    } catch (error) {
        console.error(`${LOG_PREFIX} !!!!! MoodMusic Initialization FAILED !!!!!`, error);
        $("#extensions_settings").append(`<div class="error" style="color:red;"><b>MoodMusic INIT FAILED:</b> ${error.message || 'Unknown error'}. Check Console.</div>`);
        isInitialized = false;
        $('.moodmusic-settings').remove();
    }
    console.log(`${LOG_PREFIX} Initialize END (isInitialized = ${isInitialized})`);
}

$(document).ready(() => {
    console.log(`${LOG_PREFIX} Document ready. Starting initialization timeout (1500ms).`); // Increased timeout
    setTimeout(initializeExtension, 1500);
});

window.testMoodMusicTrigger = triggerMoodAnalysisAndPlay;
window.testMoodMusicToggle = toggleExtensionActiveState;
console.log(`${LOG_PREFIX} Client script loaded. testMoodMusicTrigger(), testMoodMusicToggle() exposed.`);
// --- END OF FILE index.js ---