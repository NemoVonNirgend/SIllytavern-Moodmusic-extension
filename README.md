# Mood Music Extension for SillyTavern

This extension allows SillyTavern to play music from Spotify based on the mood and context of your chat. It uses AI to suggest songs and interacts with a backend plugin to control Spotify playback.

## Features

*   Analyzes chat history to determine the mood.
*   Uses your configured AI model via a dedicated preset to suggest songs.
*   Connects to Spotify to search for and play suggested music.
*   Provides UI controls to save Spotify credentials, log in, and pause/resume music suggestions.

## Prerequisites

1.  **SillyTavern Installed:** You must have a working installation of SillyTavern.
2.  **Spotify Account:** A Spotify account (Premium is generally recommended for best playback control via API).
3.  **Spotify Developer App:** You will need to create an app on the Spotify Developer Dashboard.

## Installation Guide

Follow these steps carefully to install and configure the Mood Music extension and plugin.

### Step 1: Install the Backend Plugin

The backend plugin handles communication with the Spotify API.

1.  **Download Files:** Download the plugin files. You should have a folder named `moodmusic` (containing `index.mjs` and any other server-side files).
2.  **Copy to Plugins Folder:**
    *   Navigate to your SillyTavern installation directory.
    *   Place the entire `moodmusic` folder into the `SillyTavern/plugins/` directory.
    *   The final path should look like: `SillyTavern/plugins/moodmusic/index.mjs`

### Step 2: Install the Frontend Extension

The frontend extension provides the UI and client-side logic.

1.  **Download Files:** Download the extension files. You should have a folder named `moodmusic-extension` (containing `index.js`, `style.css`, `settings.html`, and `manifest.json`).
2.  **Copy to Extensions Folder:**
    *   Navigate to your SillyTavern installation directory.
    *   Place the entire `moodmusic-extension` folder into the `SillyTavern/public/scripts/extensions/third-party/` directory.
    *   The final path should look like: `SillyTavern/public/scripts/extensions/third-party/moodmusic-extension/manifest.json`

### Step 3: Set Up Your Spotify Developer App

You need to create a Spotify App to get API credentials.

1.  **Go to Spotify Dashboard:** Open your web browser and navigate to [https://developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).
2.  **Log In:** Log in with your Spotify account.
3.  **Create an App:**
    *   Click "Create App" (or "Create a Client ID").
    *   Fill in the App Name (e.g., "SillyTavern Mood Music") and App Description.
    *   Agree to the terms.
4.  **Note Credentials:** Once the app is created, you will see your **Client ID**. Click "Show client secret" to view your **Client Secret**. Copy both of these values securely; you will need them later.
5.  **Configure Redirect URI:**
    *   In your app's settings on the Spotify Developer Dashboard, find the "Redirect URIs" section (you might need to click "Edit Settings").
    *   Add the following Redirect URI: `http://127.0.0.1:8000/api/plugins/moodmusic/auth/callback`
        *   **Note:** If your SillyTavern instance runs on a port other than `8000`, replace `8000` with your correct port number.
    *   Click "Save" at the bottom of the Spotify app settings page.

### Step 4: Configure the Extension in SillyTavern

1.  **Restart SillyTavern:** If SillyTavern is running, stop it and restart it to load the new plugin and extension.
2.  **Open Extension Settings:**
    *   In SillyTavern, click on the "Extensions" icon (usually a plug icon 🔌) in the top right or left panel.
    *   Scroll down to find the "Mood Music Settings" section.
3.  **Enter Spotify Credentials:**
    *   In the "Client ID" field, paste the Client ID you copied from the Spotify Developer Dashboard.
    *   In the "Client Secret" field, paste the Client Secret you copied.
    *   Click the "Save Credentials" button. The "Spotify Credentials" status should change from "Not Set" to "Set".
4.  **Log In to Spotify:**
    *   Once credentials are saved and show as "Set", the "Login to Spotify" button should become active.
    *   Click the "Login to Spotify" button.
    *   A popup window will appear asking you to authorize your Spotify app. Log in if prompted and click "Agree" or "Authorize".
    *   After successful authorization, the popup should close, and the "Auth Status" in SillyTavern should change to "Logged In".

### Step 5: Set Up the AI Preset

The extension uses a specific AI preset named "Music" to generate song suggestions.

1.  **Import Preset:**
    *   Locate the `Music.json` file.
    *   In SillyTavern, go to the "Chat Configuration" tab.
    *   Click on "Import Presets".
    *   Click "Import" and select the `Music.json` file.
2.  **Ensure Correct Preset Name:**
    *   After importing, the preset might be named "Music". The extension specifically looks for a preset named **"Music"**.
    *   If necessary, rename the imported preset to exactly "Music" in the SillyTavern preset management interface.
    *   Alternatively, you can create a new preset named "Music" and copy the system prompt content from the provided JSON file into its main system prompt field. The key system prompt content is:
        ```
        You are an assistant that suggests music based on the mood of a conversation. Analyze the provided snippet and suggest ONE song title and artist. Be creative, and choose from a wide variety of genres and styles, not just the most popular, or most obvious. You are a highly skilled, and talented DJ, with a extremely broad knowledge of music. Pick niche music you think {{user}} might not have heard before, you can pick music from many different genre's, styles, and countries, try to relate at least one aspect of the scene to the current song. Output ONLY the title and artist in the format:
        Title: [Song Title]
        Artist: [Artist Name]
        ```

## Usage

*   Once configured and logged in, the extension will automatically analyze chat messages.
*   When it deems appropriate (after a period of no music playing or after a song ends), it will:
    1.  Temporarily switch to the "Music" AI preset.
    2.  Send a request to the AI for a song suggestion.
    3.  Switch back to your original AI preset.
    4.  Attempt to play the suggested song on Spotify.
*   Use the "Pause Music" / "Resume Music" button in the Mood Music Settings to temporarily disable or re-enable automatic suggestions and playback.
*   Ensure Spotify is open and active on one of your devices for playback to start. The plugin will try to play on your active device or the first available one.

## Troubleshooting

*   **"Credentials not set" / "Login button disabled":** Double-check that you have correctly saved your Client ID and Secret from Spotify in the extension settings.
*   **"Auth Status: Not Logged In":** Ensure you have clicked the "Login to Spotify" button and successfully authorized the app in the Spotify popup.
*   **Music not playing:**
    *   Ensure Spotify is open on a device (desktop, web, mobile).
    *   Check if there's an active device in your Spotify Connect list.
    *   Confirm your AI preset named "Music" is correctly configured with the specified system prompt.
    *   Look for error messages in the SillyTavern console (usually accessible by pressing F12 in your browser and going to the "Console" tab) and the SillyTavern server command-line window.
*   **After any file changes or initial setup:** Always restart SillyTavern completely.
