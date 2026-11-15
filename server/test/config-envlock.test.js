import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../src/Config.js';

const silent = { log: () => { }, error: () => { } };

/**
 * Config mit isolierter config.json (CONFIG_PATH) + optionalen Env-Variablen.
 */
function makeConfig(configPath, env = {}) {
    return new Config({ CONFIG_PATH: configPath, ...env }, silent);
}

describe('Config – envLocked (Env-gelockte Felder)', () => {
    let dir, configPath;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'vui-config-envlock-'));
        configPath = join(dir, 'config.json');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    describe('getSettings().envLocked', () => {
        it('ist leer, wenn keine Env-Variablen gesetzt sind', () => {
            const config = makeConfig(configPath);
            const s = config.getSettings();
            expect(s.envLocked).toEqual({ root: {}, whisper: {}, llm: {}, security: {}, media: {} });
        });

        it('markiert Whisper-Felder, die per Env gesetzt sind', () => {
            const config = makeConfig(configPath, {
                WHISPER_LANG: 'en',
                WHISPER_TRANSLATE: 'true',
                WHISPER_BEAM_SIZE: '7'
            });
            const s = config.getSettings();
            expect(s.envLocked.whisper).toEqual({
                language: 'WHISPER_LANG',
                translate: 'WHISPER_TRANSLATE',
                beamSize: 'WHISPER_BEAM_SIZE'
            });
            // Wert stammt aus der Env
            expect(s.whisper.language).toBe('en');
            expect(s.whisper.translate).toBe(true);
            expect(s.whisper.beamSize).toBe(7);
        });

        it('markiert LLM-Felder, die per Env gesetzt sind', () => {
            const config = makeConfig(configPath, { LLM_HOST: 'llama.local', LLM_MODEL: 'qwen' });
            const s = config.getSettings();
            expect(s.envLocked.llm).toEqual({ host: 'LLM_HOST', model: 'LLM_MODEL' });
        });

        it('markiert Security-Felder, die per Env gesetzt sind', () => {
            const config = makeConfig(configPath, { SECURITY_MAX_TOOL_TURNS: '3' });
            const s = config.getSettings();
            expect(s.envLocked.security).toEqual({ maxToolTurns: 'SECURITY_MAX_TOOL_TURNS' });
        });

        it('markiert Media-Felder, die per Env gesetzt sind', () => {
            const config = makeConfig(configPath, { MEDIA_DIR: '/tmp/media' });
            const s = config.getSettings();
            expect(s.envLocked.media).toEqual({ dir: 'MEDIA_DIR' });
        });

        it('markiert Root-Felder (serverPort, verbose, whisperHost/Port, badwords)', () => {
            const config = makeConfig(configPath, {
                SERVER_PORT: '4000',
                VERBOSE: 'true',
                WHISPER_HOST: 'whisper.local',
                WHISPER_PORT: '10301',
                WHISPER_BADWORDS: 'spam,werbe'
            });
            const s = config.getSettings();
            expect(s.envLocked.root).toEqual({
                serverPort: 'SERVER_PORT',
                verbose: 'VERBOSE',
                whisperHost: 'WHISPER_HOST',
                whisperPort: 'WHISPER_PORT',
                badwords: 'WHISPER_BADWORDS'
            });
            expect(s.serverPort).toBe(4000);
            expect(s.verbose).toBe(true);
            expect(s.whisperHost).toBe('whisper.local');
            expect(s.whisperPort).toBe(10301);
            expect(s.badwords).toEqual(['spam', 'werbe']);
        });

        it('markiert WHISPER_TRANSLATE=false als gelockt (explizites false)', () => {
            const config = makeConfig(configPath, { WHISPER_TRANSLATE: 'false' });
            const s = config.getSettings();
            expect(s.envLocked.whisper).toEqual({ translate: 'WHISPER_TRANSLATE' });
            expect(s.whisper.translate).toBe(false);
        });

        it('markiert ungültige Env-Werte NICHT als gelockt (Fallback auf Default)', () => {
            const config = makeConfig(configPath, { WHISPER_BEAM_SIZE: 'abc' });
            const s = config.getSettings();
            expect(s.envLocked.whisper).toEqual({});
            expect(s.whisper.beamSize).toBe(5);
        });
    });

    describe('updateSettings() – Env hat Vorrang', () => {
        it('ignoriert Env-gelockte Whisper-Felder im Patch', () => {
            const config = makeConfig(configPath, { WHISPER_LANG: 'en', WHISPER_BEAM_SIZE: '7' });
            const result = config.updateSettings({ whisper: { language: 'de', beamSize: 3, patience: 0.5 } });

            // Gelockte Werte bleiben unverändert (Env gewinnt)
            expect(config.whisper.language).toBe('en');
            expect(config.whisper.beamSize).toBe(7);
            // Ungelocktes Feld wird angewendet
            expect(config.whisper.patience).toBe(0.5);
            // Gelockte Keys werden nicht als "changed" gemeldet
            expect(result.applied).toContain('whisper');
        });

        it('ignoriert Env-gelockte LLM-Felder im Patch', () => {
            const config = makeConfig(configPath, { LLM_HOST: 'llama.local' });
            config.updateSettings({ llm: { host: 'other.local', model: 'qwen' } });
            expect(config.llm.host).toBe('llama.local');
            expect(config.llm.model).toBe('qwen');
        });

        it('ignoriert Env-gelockte Security-Felder im Patch', () => {
            const config = makeConfig(configPath, { SECURITY_MAX_TOOL_TURNS: '3' });
            config.updateSettings({ security: { maxToolTurns: 99, toolTimeoutMs: 5000 } });
            expect(config.security.maxToolTurns).toBe(3);
            expect(config.security.toolTimeoutMs).toBe(5000);
        });

        it('ignoriert Env-gelockte Media-Felder im Patch', () => {
            const config = makeConfig(configPath, { MEDIA_DIR: '/tmp/media' });
            config.updateSettings({ media: { dir: '/other', maxImages: 10 } });
            expect(config.media.dir).toBe('/tmp/media');
            expect(config.media.maxImages).toBe(10);
        });

        it('ignoriert Env-gelockte Root-Felder im Patch', () => {
            const config = makeConfig(configPath, { WHISPER_HOST: 'whisper.local', WHISPER_BADWORDS: 'spam' });
            config.updateSettings({ whisperHost: 'other.local', badwords: ['neu'] });
            expect(config.whisperHost).toBe('whisper.local');
            expect(config.badwords).toEqual(['spam']);
        });

        it('persistiert Env-gelockte Werte unverändert in config.json', () => {
            const config = makeConfig(configPath, { WHISPER_LANG: 'en' });
            config.updateSettings({ whisper: { language: 'de', patience: 0.5 } });
            const saved = JSON.parse(readFileSync(configPath, 'utf8'));
            expect(saved.whisper.language).toBe('en');
            expect(saved.whisper.patience).toBe(0.5);
        });
    });
});
