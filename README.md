# Mood Music server plugin for SillyTavern

This is the server half of [Mood Music](https://github.com/NemoVonNirgend/SIllytavern-Moodmusic-Ext). It keeps Spotify credentials and OAuth tokens out of browser storage, searches for model-selected tracks, and controls Spotify Connect playback.

Version 3 is directly installable as a SillyTavern server plugin and targets SillyTavern 1.18 / Node.js 20.

## Install

From the SillyTavern directory:

```bash
node plugins.js install https://github.com/NemoVonNirgend/SIllytavern-Moodmusic-extension
```

Set this in `config.yaml`:

```yaml
enableServerPlugins: true
```

Restart SillyTavern. The server log should include:

```text
[Mood Music Plugin] v3.0.0 initialized.
```

Then install the [frontend extension](https://github.com/NemoVonNirgend/SIllytavern-Moodmusic-Ext) through SillyTavern's extension installer.

## Spotify configuration

Create a Spotify Web API application and register the callback used by your SillyTavern origin:

```text
http://127.0.0.1:8000/api/plugins/moodmusic/auth/callback
```

Spotify requires an exact redirect match, requires HTTPS except for explicit loopback IPs, and does not accept `localhost`. The plugin automatically converts a local `localhost` request origin to `127.0.0.1`.

For stable server configuration, set:

```text
MOODMUSIC_SPOTIFY_CLIENT_ID=...
MOODMUSIC_SPOTIFY_CLIENT_SECRET=...
MOODMUSIC_SPOTIFY_REDIRECT_URI=https://your.example/api/plugins/moodmusic/auth/callback
```

The redirect variable is optional for a direct local `127.0.0.1` setup. Credentials supplied from environment variables cannot be overwritten from the frontend. Credentials supplied through the frontend remain in memory only.

Spotify playback control requires Premium. In Development Mode, the app owner must have Premium and each Spotify account using the app must be on its allowlist.

## API

All routes are mounted under `/api/plugins/moodmusic`.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Plugin ID and version |
| `GET` | `/config` | Credential presence, source, and effective redirect URI |
| `POST` | `/config` | Set in-memory app credentials |
| `GET` | `/auth/login` | Start Spotify Authorization Code flow |
| `GET` | `/auth/callback` | Complete Spotify authorization |
| `GET` | `/auth/status` | Read connection state |
| `POST` | `/auth/logout` | Clear access and refresh tokens |
| `GET` | `/playback/state` | Read a normalized playback state |
| `GET` | `/devices` | List controllable Spotify devices |
| `POST` | `/play` | Search for and play a title/artist suggestion |

Mutating routes use SillyTavern's global JSON and CSRF middleware.

## Security and reliability

- OAuth requests use expiring, single-use cryptographic state values.
- Callback text is HTML-escaped.
- Spotify requests have bounded timeouts.
- Concurrent token refreshes share one request.
- API responses never return credentials or tokens.
- Track suggestions and credential lengths are validated.
- Errors distinguish setup, login, Premium/allowlist, device, and rate-limit failures.
- Access and refresh tokens are cleared on server shutdown and are never written to disk.

## Repository layout

- `index.mjs` — directly loadable package entry point
- `moodmusic/index.mjs` — plugin routes and Spotify client
- `moodmusic/lib.mjs` — pure validation and error helpers
- `moodmusic-extension/` — synchronized frontend distribution copy
- `Music.json` — legacy 2.x preset retained only for upgrade history; v3 does not use it

## Development

```bash
npm test
```

## License

AGPL-3.0.
