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
        // Tool-Support-Cache: null = unbekannt, true/false = erkannt.
        this._toolSupport = null;
        this._toolSupportSignature = undefined;
        // Vision-Capability-Cache: undefined = unbekannt, true/false = erkannt.
        this._visionCache = undefined;
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
        const cfg = { api, baseUrl: this.normalizeUrl(base), modelName: llm.model || '' };

        // Cache-Invalidierung: Bei Änderung von api/baseUrl/modelName sind die
        // erkannten Capability-Ergebnisse (Tool-Support, Vision) nicht mehr
        // gültig → zurücksetzen.
        const signature = `${api}|${cfg.baseUrl}|${cfg.modelName}`;
        if (this._toolSupportSignature !== undefined && this._toolSupportSignature !== signature) {
            this._toolSupport = null;
            this._visionCache = undefined;
        }
        this._toolSupportSignature = signature;

        return cfg;
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
     * Sendet eine Chat-Anfrage und liefert den vollständigen Antworttext inkl. Token-Usage.
     * @param {Array<object>} messages - Array von Chat-Nachrichten
     * @param {object} [options={}] - Zusätzliche Optionen (z. B. model, temperature)
     * @returns {Promise<{content: string|null, usage: {prompt: number, completion: number, total: number}}>}
     *          Der Antworttext des Assistenten plus der verbrauchten Tokens
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

                const turn = this._extractOpenAITurn(res.data);
                const content = turn.content ?? turn.refusal;
                if (content === null || content === undefined) {
                    throw new Error('LLM lieferte keine Antwort (content und refusal leer)');
                }
                return { content, usage: turn.usage };
            }

            const res = await axios.post(`${base}/api/chat`, {
                model: llmOptions.model || cfg.modelName,
                messages: messages,
                stream: false,
                ...llmOptions
            }, { signal });
            const turn = this._extractOllamaTurn(res.data);
            return { content: turn.content, usage: turn.usage };
        } catch (error) {
            this.logger.error(this.label, 'Chat fehlgeschlagen', { error: error.message });
            throw error;
        }
    }

    /**
     * Non-streaming Chat mit Function-Calling (Tools).
     * Liefert den vollständigen Turn inkl. angeforderter Tool-Calls und Token-Usage.
     * @param {Array<object>} messages - Array von Chat-Nachrichten
     * @param {Array<object>} [tools] - OpenAI-Function-Tools (leer/undefined = ohne Tools)
     * @param {object} [options={}] - Zusätzliche Optionen (z. B. model, temperature)
     * @returns {Promise<{content: string|null, toolCalls: Array<object>, refusal: string|null, usage: {prompt: number, completion: number, total: number}}>}
     */
    async chatWithTools(messages, tools, options = {}) {
        const cfg = this.chatConfig;
        const base = this.normalizeUrl(cfg.baseUrl);
        const { signal, ...llmOptions } = options;

        const payload = {
            model: llmOptions.model || cfg.modelName,
            messages,
            ...(tools && tools.length > 0 ? { tools } : {}),
            ...llmOptions
        };

        try {
            if (cfg.api === 'openai') {
                const res = await axios.post(`${base}/chat/completions`, payload, { signal });
                return this._extractOpenAITurn(res.data);
            }

            // Ollama: Tools werden über `tools` im Payload übergeben (OpenAI-kompatibel).
            const res = await axios.post(`${base}/api/chat`, { ...payload, stream: false }, { signal });
            return this._extractOllamaTurn(res.data);
        } catch (error) {
            this.logger.error(this.label, 'ChatWithTools fehlgeschlagen', { error: error.message });
            throw error;
        }
    }

    /**
     * Extrahiert einen LLM-Turn (content + tool_calls + refusal + usage) aus einer OpenAI-Antwort.
     * @param {object} data - Die Response-Data (`{ choices: [...], usage: {...} }`)
     * @returns {{content: string|null, toolCalls: Array<object>, refusal: string|null, usage: {prompt: number, completion: number, total: number}}}
     */
    _extractOpenAITurn(data) {
        const message = data?.choices?.[0]?.message || {};
        const usage = data?.usage || {};
        return {
            content: typeof message.content === 'string' ? message.content : null,
            toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
            refusal: typeof message.refusal === 'string' ? message.refusal : null,
            usage: {
                prompt: usage.prompt_tokens ?? 0,
                completion: usage.completion_tokens ?? 0,
                total: usage.total_tokens ?? 0,
            },
        };
    }

    /**
     * Extrahiert einen LLM-Turn (content + tool_calls + refusal + usage) aus einer Ollama-Antwort.
     * Ollama nutzt das OpenAI-Format (`message.tool_calls`).
     * Usage kommt aus `prompt_eval_count` (Prompt) und `eval_count` (Completion).
     * @param {object} data - Die Response-Data (`{ message: {...}, prompt_eval_count, eval_count }`)
     * @returns {{content: string|null, toolCalls: Array<object>, refusal: string|null, usage: {prompt: number, completion: number, total: number}}}
     */
    _extractOllamaTurn(data) {
        const message = data?.message || {};
        const prompt = data?.prompt_eval_count ?? 0;
        const completion = data?.eval_count ?? 0;
        return {
            content: typeof message.content === 'string' ? message.content : null,
            toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
            refusal: typeof message.refusal === 'string' ? message.refusal : null,
            usage: {
                prompt,
                completion,
                total: prompt + completion,
            },
        };
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

    /**
     * Merged einen inkrementellen Tool-Call (OpenAI liefert `delta.tool_calls`
     * Chunk für Chunk) in den Akkumulator-Array (indexiert nach `index`).
     * @param {Array<object>} acc - Akkumulator (indexiert nach Tool-Call-Index)
     * @param {object} tc - Teil-Tool-Call aus einem Chunk
     * @private
     */
    _mergeToolCall(acc, tc) {
        const idx = (typeof tc.index === 'number') ? tc.index : 0;
        if (!acc[idx]) {
            acc[idx] = { id: tc.id || null, type: tc.type || 'function', function: { name: '', arguments: '' } };
        }
        if (tc.id) acc[idx].id = tc.id;
        if (tc.type) acc[idx].type = tc.type;
        const fn = tc.function || {};
        if (fn.name) acc[idx].function.name += fn.name;
        if (fn.arguments) acc[idx].function.arguments += fn.arguments;
    }

    /**
     * Streamt Chat-Completions mit Function-Calling (Tools).
     * Wie `streamChat()`, aber: `tools` im Payload, und am Ende des Streams
     * wird der finale Turn (content + tool_calls) rekonstruiert und als
     * `{ phase: 'turn', content, toolCalls }` geliefert.
     * @param {Array<object>} messages - Array von Chat-Nachrichten
     * @param {Array<object>} [tools] - OpenAI-Function-Tools (leer/undefined = ohne Tools)
     * @param {object} [options={}] - Zusätzliche Optionen
     * @yields {object} Objekte mit phase ('thinking' | 'answer' | 'stats' | 'turn')
     */
    async *streamChatWithTools(messages, tools, options = {}) {
        const cfg = this.chatConfig;
        let responseModel = cfg.modelName;
        let promptTokens = 0;
        let completionTokens = 0;
        let totalTokens = 0;
        let content = '';
        let reasoningContent = '';  // Reasoning-Modelle: muss beim Replay mitgegeben werden
        const openaiToolCalls = []; // inkrementelle Akkumulation (nach Index)
        let ollamaToolCalls = [];   // letztes vollständiges Array gewinnt

        const toolsPayload = (tools && tools.length > 0) ? { tools } : {};

        for await (const chunk of this.streamChunks(messages, { ...options, ...toolsPayload })) {
            if (chunk.model) responseModel = chunk.model;

            if (cfg.api === 'openai') {
                const delta = chunk.choices?.[0]?.delta || {};
                const reasoning = delta.reasoning_content ?? delta.thinking ?? '';
                if (reasoning) {
                    reasoningContent += reasoning;
                    yield { phase: 'thinking', token: reasoning };
                }
                if (delta.content) {
                    content += delta.content;
                    yield { phase: 'answer', token: delta.content };
                }
                if (Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) this._mergeToolCall(openaiToolCalls, tc);
                }

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
                if (reasoning) {
                    reasoningContent += reasoning;
                    yield { phase: 'thinking', token: reasoning };
                }
                if (msg.content) {
                    content += msg.content;
                    yield { phase: 'answer', token: msg.content };
                }
                if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                    ollamaToolCalls = msg.tool_calls;
                }

                // Ollama liefert im finalen Chunk `prompt_eval_count` (Prompt)
                // und `eval_count` (Completion). Total = Summe beider.
                if (chunk.done) {
                    promptTokens = chunk.prompt_eval_count ?? 0;
                    completionTokens = chunk.eval_count ?? 0;
                    totalTokens = promptTokens + completionTokens;
                }
            }
        }

        const toolCalls = (cfg.api === 'openai') ? openaiToolCalls.filter(Boolean) : ollamaToolCalls;

        yield {
            phase: 'stats',
            tokens: { prompt: promptTokens, completion: completionTokens, total: totalTokens },
            model: responseModel,
        };
        yield { phase: 'turn', content, toolCalls, reasoning: reasoningContent };
    }

    /**
     * Prüft einmalig, ob das LLM-Backend OpenAI-Function-Calling unterstützt.
     * Das Ergebnis wird gecacht und bei Modell-/Backend-Wechsel invalidiert
     * (siehe `chatConfig`-Getter).
     * @returns {Promise<boolean>} true = Tool-Support erkannt, false = nicht
     */
    async detectToolSupport() {
        // Zuerst `chatConfig` aufrufen: Der Getter prüft die Signatur
        // (api|baseUrl|model) und invalidiert den Cache bei Modell-/Backend-Wechsel.
        // Ohne diesen Aufruf würde der Cache-Short-Circuit unten ein veraltetes
        // Ergebnis liefern, weil die Invalidierung nie erreicht wird.
        this.chatConfig;
        if (this._toolSupport !== null) return this._toolSupport;

        const probeTools = [{
            type: 'function',
            function: {
                name: 'get_time',
                description: 'Get the current time. You MUST use this tool.',
                parameters: { type: 'object', properties: {} },
            },
        }];

        try {
            // max_tokens bewusst großzügig: Reasoning-Modelle (z. B. Qwen3)
            // verbrauchen zuerst Tokens für `reasoning_content` und emittieren
            // den Tool-Call erst danach. Zu niedrig (z. B. 30) → finish_reason
            // "length" ohne tool_calls → falsches "kein Tool-Support".
            const res = await this.chatWithTools(
                [{ role: 'user', content: 'What time is it now? Use the get_time tool.' }],
                probeTools,
                { max_tokens: 200 },
            );
            this._toolSupport = Array.isArray(res.toolCalls) && res.toolCalls.length > 0;
        } catch {
            this._toolSupport = false;
        }

        this.logger.log(this.label, `Tool-Support: ${this._toolSupport ? 'ja' : 'nein'}`);
        return this._toolSupport;
    }

    /**
     * Capability-Gate: Kann das aktuelle Modell Vision?
     * `llm.vision` TriState (`auto`/`true`/`false`, Default `auto`):
     * - `true`/`false` erzwingen das Ergebnis.
     * - `auto` + Ollama → `GET /api/show?name=<modell>`, `capabilities` enthält `"vision"`?
     * - `auto` + OpenAI-kompatibel → `false` (kein Capabilities-Endpoint).
     * Das Ergebnis wird gecacht und bei Modell-/Backend-Wechsel invalidiert
     * (siehe `chatConfig`-Getter). Fehler → `false` (Graceful Degradation).
     * @returns {Promise<boolean>} true = Modell kann Vision, false = nicht
     */
    async visionEnabled() {
        const v = this.config?.llm?.vision ?? 'auto';
        if (v === true) return true;
        if (v === false) return false;

        // Zuerst `chatConfig` aufrufen: Der Getter prüft die Signatur
        // (api|baseUrl|model) und invalidiert den Cache bei Modell-/Backend-Wechsel.
        this.chatConfig;
        if (this._visionCache !== undefined) return this._visionCache;

        const cfg = this.chatConfig;
        if (cfg.api === 'ollama') {
            try {
                const res = await axios.get(`${cfg.baseUrl}/api/show`, {
                    params: { name: cfg.modelName },
                });
                this._visionCache = Array.isArray(res.data?.capabilities)
                    && res.data.capabilities.includes('vision');
            } catch {
                this._visionCache = false;
            }
        } else {
            this._visionCache = false;
        }

        this.logger.log(this.label, `Vision: ${this._visionCache ? 'ja' : 'nein'}`);
        return this._visionCache;
    }

    /**
     * Baut die `role:'tool'`-Message je Backend (Multimodal-Content-Parts).
     * - Kein Bild → plain String (wie heute, Backward-Compat).
     * - Ollama: `[{ type:'text', text }, { type:'image', images: [base64] }]`
     * - OpenAI-kompatibel: `[{ type:'text', text }, { type:'image_url', image_url: { url: 'data:<mime>;base64,<data>' } }]`
     * @param {string} content - Der (ggf. untrusted-gepackte) Text des Tool-Ergebnisses
     * @param {Array<{mimeType: string, data: string}>} [images] - Base64-Bilder
     * @param {string} [backend] - 'ollama' | 'openai' (aus `chatConfig.api`)
     * @returns {string|Array<object>} Plain String oder Content-Parts-Array
     */
    buildToolMessage(content, images = [], backend) {
        if (!images.length) return content;
        if (backend === 'ollama') {
            return [
                { type: 'text', text: content },
                ...images.map((i) => ({ type: 'image', images: [i.data] })),
            ];
        }
        return [
            { type: 'text', text: content },
            ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
        ];
    }
}

export { Llm };
