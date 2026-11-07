import axios from 'axios';
import { Readable } from 'node:stream';

/**
 * LLM service for chat completions via Ollama or OpenAI-compatible APIs.
 *
 * Die Konfiguration wird zur Aufrufzeit aus `config.llm` gelesen
 * (Getter `chatConfig`), damit Settings-Änderungen sofort wirksam werden,
 * ohne Neustart.
 */
class Llm {
    /**
     * @param {object} [params]
     * @param {object} [params.config] - Config-Objekt (liest `config.llm`)
     * @param {Logger} [params.logger] - Logger-Instanz
     */
    constructor({ config, logger } = {}) {
        this.config = config;
        this.label = '[Llm]';
        this.logger = logger || { log: () => { }, error: () => { } };
    }

    /**
     * Liest die Chat-Konfiguration zur Aufrufzeit aus `config.llm`.
     * @returns {{api: string, baseUrl: string, modelName: string}}
     */
    get chatConfig() {
        const llm = this.config?.llm || {};
        const api = (llm.api === 'openai') ? 'openai' : 'ollama';
        const host = llm.host || '';
        const port = llm.port || 8080;
        const base = (api === 'openai')
            ? `http://${host}:${port}/v1`
            : `http://${host}:${port}`;
        return { api, baseUrl: this.normalizeUrl(base), modelName: llm.model || '' };
    }

    /**
     * Normalisiert eine URL, indem führende/abschließende Schrägstriche entfernt werden.
     * @param {string} url - Die zu normalisierende URL
     * @returns {string}
     */
    normalizeUrl(url) {
        return String(url || '').replace(/\/+$/, '');
    }

    /**
     * Sendet eine Chat-Anfrage und liefert den vollständigen Antworttext.
     * @param {Array<object>} messages - Array von Chat-Nachrichten
     * @param {object} [options={}] - Zusätzliche Optionen (z. B. model, temperature)
     * @returns {Promise<string>} Der Antworttext des Assistenten
     */
    async chat(messages, options = {}) {
        const cfg = this.chatConfig;
        const base = this.normalizeUrl(cfg.baseUrl);
        const { signal, ...llmOptions } = options;

        try {
            if (cfg.api === 'openai') {
                const res = await axios.post(`${base}/chat/completions`, {
                    model: llmOptions.model || cfg.modelName,
                    messages: messages,
                    ...llmOptions
                }, { signal });

                this.logger.log(this.label, 'CHOICES', res.data.choices);

                return this._extractOpenAIAnswer(res.data);
            }

            const res = await axios.post(`${base}/api/chat`, {
                model: llmOptions.model || cfg.modelName,
                messages: messages,
                stream: false,
                ...llmOptions
            }, { signal });
            return res.data.message.content;
        } catch (error) {
            this.logger.error(this.label, 'Chat fehlgeschlagen', { error: error.message });
            throw error;
        }
    }

    /**
     * Extrahiert die Antwort aus einer OpenAI-Chat-Completion-Antwort.
     * Behandelt `content: null` gemäß Spec (Refusal / Tool-Calls):
     * `content` (string) hat Vorrang, sonst `refusal`, sonst Fehler.
     * @param {object} data - Die Response-Data (`{ choices: [...] }`)
     * @returns {string} Der Antworttext
     */
    _extractOpenAIAnswer(data) {
        const message = data?.choices?.[0]?.message || {};
        if (typeof message.content === 'string') {
            return message.content;
        }
        if (typeof message.refusal === 'string') {
            return message.refusal;
        }
        throw new Error('LLM lieferte keine Antwort (content und refusal leer)');
    }

    /**
     * Parst einen SSE (Server-Sent Events)-Stream in JSON-Objekte.
     * @param {ReadableStream} body - Der Response-Body (Web-Stream)
     * @yields {object} Geparste JSON-Chunks
     * @private
     */
    async *_readSSE(body) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 1);
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]' || !trimmed.startsWith('data:')) continue;
                    const payload = trimmed.slice(5).trim();
                    if (payload === '') continue;
                    try { yield JSON.parse(payload); } catch { /* unvollständige/ungültige Zeile überspringen */ }
                }
            }
            const tail = decoder.decode();
            if (tail.trim() && tail.trim() !== 'data: [DONE]') {
                try { yield JSON.parse(tail.trim()); } catch { /* unvollständige/ungültige Zeile überspringen */ }
            }
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Parst einen NDJSON-Stream in JSON-Objekte.
     * @param {ReadableStream} body - Der Response-Body (Web-Stream)
     * @yields {object} Geparste JSON-Chunks
     * @private
     */
    async *_readNDJSON(body) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (line === '') continue;
                    try { yield JSON.parse(line); } catch { /* unvollständige/ungültige Zeile überspringen */ }
                }
            }
            const tail = buffer.trim();
            if (tail) {
                try { yield JSON.parse(tail); } catch { /* unvollständige/ungültige Zeile überspringen */ }
            }
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Liest einen Node-Stream vollständig als Text (für Fehlerdetails).
     * @param {Readable} stream - Node-Readable-Stream
     * @returns {Promise<string>}
     * @private
     */
    async _streamToText(stream) {
        if (!stream) return '';
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks).toString('utf8');
    }

    /**
     * Streamt Chat-Completions und liefert rohe Chunk-Objekte.
     * @param {Array<object>} messages - Array von Chat-Nachrichten
     * @param {object} [options={}] - Zusätzliche Optionen
     * @yields {object} Rohe Streaming-Chunks
     */
    async *streamChunks(messages, options = {}) {
        const cfg = this.chatConfig;
        const base = this.normalizeUrl(cfg.baseUrl);
        const { signal, ...llmOptions } = options;

        const payload = {
            model: llmOptions.model || cfg.modelName,
            messages,
            stream: true,
            // OpenAI liefert `usage` im Stream nur, wenn explizit angefordert.
            ...(cfg.api === 'openai' ? { stream_options: { include_usage: true } } : {}),
            ...llmOptions
        };

        const url = (cfg.api === 'openai') ? `${base}/chat/completions` : `${base}/api/chat`;

        let res;
        try {
            res = await axios.post(url, payload, {
                responseType: 'stream',
                signal,
                validateStatus: () => true
            });
        } catch (error) {
            this.logger.error(this.label, 'Chat-Streaming fehlgeschlagen', { error: error.message });
            throw error;
        }

        if (res.status < 200 || res.status >= 300) {
            const detail = await this._streamToText(res.data).catch(() => '');
            this.logger.error(this.label, 'Chat-Streaming fehlgeschlagen', { status: res.status, detail });
            throw new Error(`Chat-Streaming fehlgeschlagen: ${res.status} ${detail}`.trim());
        }

        const body = Readable.toWeb(res.data);
        yield* (cfg.api === 'openai') ? this._readSSE(body) : this._readNDJSON(body);
    }

    /**
     * Streamt Chat-Completions und liefert strukturierte { phase, token }-Objekte.
     * Am Ende des Streams wird ein zusätzliches { phase: 'stats' }-Objekt
     * mit den verbrauchten Token und dem Model-Namen geliefert.
     * @param {Array<object>} messages - Array von Chat-Nachrichten
     * @param {object} [options={}] - Zusätzliche Optionen
     * @yields {object} Objekte mit phase ('thinking' | 'answer' | 'stats') und token
     */
    async *streamChat(messages, options = {}) {
        const cfg = this.chatConfig;
        // Modell-Name: Config-Wert als Fallback, der tatsächliche Name kommt
        // aus den Response-Chunks (`chunk.model`) — das ist das Modell, das
        // die Anfrage wirklich bedient hat (z. B. wenn Config leer ist).
        let responseModel = cfg.modelName;
        let promptTokens = 0;
        let completionTokens = 0;
        let totalTokens = 0;

        for await (const chunk of this.streamChunks(messages, options)) {
            if (chunk.model) responseModel = chunk.model;

            if (cfg.api === 'openai') {
                const delta = chunk.choices?.[0]?.delta || {};
                const reasoning = delta.reasoning_content ?? delta.thinking ?? '';
                if (reasoning) yield { phase: 'thinking', token: reasoning };
                if (delta.content) yield { phase: 'answer', token: delta.content };

                // OpenAI liefert `usage` top-level im letzten Chunk (leere choices).
                const usage = chunk.usage ?? chunk.choices?.[0]?.usage;
                if (usage) {
                    promptTokens = usage.prompt_tokens ?? 0;
                    completionTokens = usage.completion_tokens ?? 0;
                    totalTokens = usage.total_tokens ?? 0;
                }
            } else {
                const msg = chunk.message || {};
                const reasoning = chunk.thinking ?? msg.thinking ?? '';
                if (reasoning) yield { phase: 'thinking', token: reasoning };
                if (msg.content) yield { phase: 'answer', token: msg.content };

                // Ollama liefert im finalen Chunk `prompt_eval_count` (Prompt)
                // und `eval_count` (Completion). Total = Summe beider.
                if (chunk.done) {
                    promptTokens = chunk.prompt_eval_count ?? 0;
                    completionTokens = chunk.eval_count ?? 0;
                    totalTokens = promptTokens + completionTokens;
                }
            }
        }

        yield {
            phase: 'stats',
            tokens: { prompt: promptTokens, completion: completionTokens, total: totalTokens },
            model: responseModel,
        };
    }
}

export { Llm };
