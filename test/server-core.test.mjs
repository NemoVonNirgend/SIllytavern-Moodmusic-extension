import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SpotifyApiError,
    cleanCredential,
    escapeHtml,
    normalizeSpotifyError,
    validateSuggestion,
} from '../moodmusic/lib.mjs';

test('cleans credentials without coercing other input types', () => {
    assert.equal(cleanCredential('  value  '), 'value');
    assert.equal(cleanCredential(123), '');
});

test('escapes content rendered in the OAuth result page', () => {
    assert.equal(escapeHtml('<script>"x" & y</script>'), '&lt;script&gt;&quot;x&quot; &amp; y&lt;/script&gt;');
});

test('validates complete bounded suggestions', () => {
    assert.deepEqual(validateSuggestion({ title: ' Roads ', artist: ' Portishead ' }), {
        title: 'Roads',
        artist: 'Portishead',
    });
    assert.throws(() => validateSuggestion({ title: 'Roads' }), SpotifyApiError);
    assert.throws(() => validateSuggestion({ title: 'x'.repeat(201), artist: 'Artist' }), SpotifyApiError);
});

test('normalizes authorization and rate-limit errors', () => {
    assert.match(normalizeSpotifyError(401, {}, null).message, /expired/i);
    const limited = normalizeSpotifyError(429, {}, '8');
    assert.equal(limited.status, 429);
    assert.match(limited.message, /8 seconds/);
});
