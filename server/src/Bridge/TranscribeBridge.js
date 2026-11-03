import { WebSocketServer } from 'ws';
import net from 'node:net';

/**
 * Audio-Parameter der Bridge (muss zur Frontend-Erfassung passen).
 * 16kHz Mono, 16-bit PCM — das Standard-Format des Wyoming-Protokolls.
 */
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const WIDTH = 2; // Byte pro Sample (16-bit)

// ~2 s Audio (16kHz * 2 Byte) pro Transkriptions-Chunk.
const FLUSH_BYTES = 64 * 1024;

// Timeout für eine einzelne Wyoming-Transkription.
const WYOMING_TIMEOUT_MS = 30000;

/**
 * WebSocket-Bridge: nimmt rohes PCM (16kHz Mono) vom Browser entgegen,
 * puffert es und transkribiert es über den faster-whisper-Service
 * (Wyoming-Protokoll, TCP). Ergebnis geht als JSON zurück.
 *
 * Läuft im noServer-Modus: das Upgrade wird vom Router gezielt hierher
 * geroutet (siehe Router.setupUpgradeRouting), damit Vite-HMR und diese
 * Bridge auf demselben httpServer koexistieren.
 */
class TranscribeBridge {
    /**
     * @param {Config} config - Configuration object
     * @param {Logger} [logger] - Logger instance
     */
    constructor(config, logger) {
        this.config = config;
        this.logger = logger || { log: () => { }, error: () => { } };
        this.label = '[TranscribeBridge]';
        // Host/Port/Parameter werden pro Transkription dynamisch aus der Config
        // gelesen, damit Settings-Updates ohne Neustart wirksam werden.

        this.wss = new WebSocketServer({ noServer: true });
        this.clients = new Set();
        this.wss.on('connection', (ws) => this.handleConnection(ws));
    }

    /**
     * Verbindungs-Handler: sammelt PCM-Chunks und triggert die
     * Transkription, sobald genug Bytes angefallen sind.
     * @param {import('ws').WebSocket} ws
     */
    handleConnection(ws) {
        this.clients.add(ws);
        this.logger.log(this.label, 'Client verbunden');

        let chunks = [];
        let totalBytes = 0;
        // Pro-Connection-Promise-Kette: hält die Antworten in Sende-Reihenfolge.
        let chain = Promise.resolve();

        ws.on('message', (data, isBinary) => {
            if (!isBinary) return; // nur binäre PCM-Chunks verarbeiten

            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            chunks.push(chunk);
            totalBytes += chunk.length;

            if (totalBytes < FLUSH_BYTES) return;

            const pcm = Buffer.concat(chunks);
            chunks = [];
            totalBytes = 0;

            chain = chain
                .then(() => this.processChunk(ws, pcm))
                .catch((err) => {
                    this.logger.error(this.label, 'Transkription fehlgeschlagen', { error: err.message });
                    this.safeSend(ws, { error: err.message });
                });
        });

        ws.on('close', () => {
            this.clients.delete(ws);
            this.logger.log(this.label, 'Client getrennt');
        });

        ws.on('error', (err) => {
            this.logger.error(this.label, 'WS-Error', { error: err.message });
        });
    }

    /**
     * Transkribiert einen PCM-Chunk und sendet das Ergebnis zurück.
     * @param {import('ws').WebSocket} ws
     * @param {Buffer} pcm
     * @returns {Promise<void>}
     */
    async processChunk(ws, pcm) {
        const raw = await this.transcribe(pcm);
        const text = this.filterBadwords(raw);
        if (text) {
            this.safeSend(ws, { text, isFinal: true });
        }
    }

    /**
     * Baut die `transcribe`-Nachricht (Wyoming-Protokoll) aus den aktuellen
     * Config-Parametern. Nur Parameter mit sinnvollem Wert werden gesendet.
     * @returns {Record<string, unknown>}
     */
    buildTranscribeData() {
        const w = this.config?.whisper || {};
        const data = {};

        if (w.language) data.language = w.language;
        if (Array.isArray(w.temperature) && w.temperature.length > 0) data.temperature = w.temperature;
        if (w.prompt) data.prompt = w.prompt;
        data.translate = Boolean(w.translate);

        if (Number.isInteger(w.beamSize)) data.beam_size = w.beamSize;
        if (Number.isInteger(w.bestOf)) data.best_of = w.bestOf;
        if (typeof w.patience === 'number') data.patience = w.patience;
        if (typeof w.lengthPenalty === 'number') data.length_penalty = w.lengthPenalty;
        if (typeof w.repetitionPenalty === 'number') data.repetition_penalty = w.repetitionPenalty;

        if (typeof w.compressionRatioThreshold === 'number') data.compression_ratio_threshold = w.compressionRatioThreshold;
        if (typeof w.logProbThreshold === 'number') data.log_prob_threshold = w.logProbThreshold;
        if (typeof w.noSpeechThreshold === 'number') data.no_speech_threshold = w.noSpeechThreshold;
        data.condition_on_previous_text = Boolean(w.conditionOnPreviousText);

        if (w.initialPrompt) data.initial_prompt = w.initialPrompt;
        if (w.hotwords) data.hotwords = w.hotwords;

        // VAD: nur aktivieren, wenn explizit gewünscht (sonst bleibt es aus).
        if (w.vadFilter) {
            data.vad_parameters = (w.vadParameters && typeof w.vadParameters === 'object') ? w.vadParameters : {};
        }

        return data;
    }

    /**
     * Filtert die Badwords (case-insensitiv) aus dem Transkript und räumt
     * dadurch entstandene Leerzeichen auf.
     * @param {string} text
     * @returns {string}
     */
    filterBadwords(text) {
        const badwords = this.config?.badwords || [];
        if (!badwords.length || !text) return text;

        let result = text;
        for (const word of badwords) {
            if (!word) continue;
            const escaped = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            result = result.replace(new RegExp(escaped, 'gi'), '');
        }
        return result.replace(/\s+/g, ' ').trim();
    }

    /**
     * Transkribiert rohes PCM über das Wyoming-Protokoll (TCP) und
     * liefert den erkannten Text zurück.
     *
     * Flow: transcribe → audio-start → audio-chunk (PCM) → audio-stop
     *       → transcript
     * @param {Buffer} pcm
     * @returns {Promise<string>}
     */
    transcribe(pcm) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const host = this.config?.whisperHost || 'vui-service';
            const port = this.config?.whisperPort || 10300;
            const client = net.connect(port, host);

            const finish = (err, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { client.destroy(); } catch { /* ignore */ }
                if (err) reject(err);
                else resolve(value);
            };

            const timer = setTimeout(() => {
                finish(new Error(`Wyoming-Timeout nach ${WYOMING_TIMEOUT_MS}ms`));
            }, WYOMING_TIMEOUT_MS);

            client.on('connect', () => {
                const fmt = { rate: SAMPLE_RATE, width: WIDTH, channels: CHANNELS };
                const sendMsg = (obj, payload) => {
                    if (payload) obj = { ...obj, payload_length: payload.length };
                    client.write(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'));
                    if (payload) client.write(payload);
                };
                sendMsg({ type: 'transcribe', data: this.buildTranscribeData() });
                sendMsg({ type: 'audio-start', data: fmt });
                sendMsg({ type: 'audio-chunk', data: fmt }, pcm);
                sendMsg({ type: 'audio-stop' });
            });

            let buf = Buffer.alloc(0);
            client.on('data', (chunk) => {
                buf = Buffer.concat([buf, chunk]);
                while (true) {
                    const nl = buf.indexOf('\n');
                    if (nl === -1) break;
                    const line = buf.slice(0, nl).toString('utf8');

                    let msg;
                    try { msg = JSON.parse(line); } catch { buf = buf.slice(nl + 1); continue; }

                    // Wyoming-Framing: Header-Zeile + data_length-Bytes (JSON) + payload_length-Bytes (Binär).
                    // TCP liefert nur einen Byte-Stream ohne Nachrichten-Grenzen: erst verarbeiten,
                    // wenn ALLE Teile der Nachricht im Puffer liegen (sonst auf weitere Daten warten).
                    const dataLen = msg.data_length || 0;
                    const payloadLen = msg.payload_length || 0;
                    const need = nl + 1 + dataLen + payloadLen;
                    if (buf.length < need) break; // noch unvollständig

                    buf = buf.slice(nl + 1);
                    if (dataLen > 0) {
                        const dataJson = buf.slice(0, dataLen).toString('utf8');
                        buf = buf.slice(dataLen);
                        try { msg.data = JSON.parse(dataJson); } catch { /* ignore */ }
                    }
                    if (payloadLen > 0) buf = buf.slice(payloadLen);

                    if (msg.type === 'transcript') {
                        finish(null, (msg.data && msg.data.text) || '');
                        return;
                    }
                    if (msg.type === 'error') {
                        finish(new Error(msg.data?.message || 'Wyoming-Fehler'));
                        return;
                    }
                }
            });

            client.on('error', (err) => finish(err));
            client.on('close', () => finish(new Error('Wyoming-Verbindung geschlossen')));
        });
    }

    /** Sendet JSON, wenn der Socket offen ist (sonst still ignorieren). */
    safeSend(ws, obj) {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    /** Beendet alle Clients und den noServer-WS (Shutdown). */
    close() {
        for (const ws of this.clients) {
            try { ws.close(); } catch { /* ignore */ }
        }
        this.clients.clear();
        this.wss.close();
    }
}

export { TranscribeBridge };
