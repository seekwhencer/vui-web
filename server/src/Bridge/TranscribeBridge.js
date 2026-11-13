
import { WebSocketServer } from 'ws';
import net from 'node:net';

/**
 * Audio parameters of the bridge.
 * 16 kHz mono, 16-bit PCM — standard Wyoming format.
 */
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const WIDTH = 2;

// Approximately 2.048 seconds of audio per transcription chunk.
const FLUSH_BYTES = 64 * 1024;

// Keep the last 500 ms for the next transcription.
const OVERLAP_SECONDS = 0.5;
const OVERLAP_BYTES = SAMPLE_RATE * WIDTH * OVERLAP_SECONDS;

// Timeout for a single Wyoming transcription.
const WYOMING_TIMEOUT_MS = 30000;

class TranscribeBridge {
    constructor(config, logger, onTranscription) {
        this.config = config;
        this.logger = logger || { log: () => { }, error: () => { } };
        this.label = '[TranscribeBridge]';
        this.onTranscription = typeof onTranscription === 'function'
            ? onTranscription
            : null;

        this.wss = new WebSocketServer({ noServer: true });
        this.clients = new Set();
        this.wss.on('connection', (ws) => this.handleConnection(ws));
    }

    /**
     * Collects PCM chunks and triggers transcription.
     * Keeps the last 500 ms of audio for the next chunk.
     */
    handleConnection(ws) {
        this.clients.add(ws);
        this.logger.log(this.label, 'Client verbunden');

        let chunks = [];
        let totalBytes = 0;
        let lastChunkText = '';

        // Keep transcription responses in order.
        let chain = Promise.resolve();

        ws.on('message', (data, isBinary) => {
            if (!isBinary) return;

            const chunk = Buffer.isBuffer(data)
                ? data
                : Buffer.from(data);

            chunks.push(chunk);
            totalBytes += chunk.length;

            if (totalBytes < FLUSH_BYTES) return;

            const pcm = Buffer.concat(chunks);

            // Preserve the last 500 ms for the next transcription.
            // PCM samples must remain aligned (2 bytes per sample).
            const overlapLength = Math.min(
                OVERLAP_BYTES,
                pcm.length - (pcm.length % WIDTH)
            );

            const overlap = Buffer.from(
                pcm.subarray(pcm.length - overlapLength)
            );

            // Start the next buffer with the overlapping audio.
            chunks = overlapLength > 0 ? [overlap] : [];
            totalBytes = overlapLength;

            chain = chain
                .then(async () => {
                    const raw = await this.transcribe(pcm);

                    // Count successful transcriptions (Wyoming 'transcript' event).
                    this.notifyTranscription();

                    const text = this.filterBadwords(raw);

                    // Remove repeated words caused by audio overlap.
                    const newText = this.removeTranscriptOverlap(
                        lastChunkText,
                        text
                    );

                    if (newText) {
                        lastChunkText = newText;

                        this.safeSend(ws, {
                            text: newText,
                            isFinal: true
                        });
                    }
                })
                .catch((err) => {
                    this.logger.error(
                        this.label,
                        'Transkription fehlgeschlagen',
                        { error: err.message }
                    );

                    this.safeSend(ws, { error: err.message });
                });
        });

        ws.on('close', () => {
            this.clients.delete(ws);
            this.logger.log(this.label, 'Client getrennt');
        });

        ws.on('error', (err) => {
            this.logger.error(
                this.label,
                'WS-Error',
                { error: err.message }
            );
        });
    }

    /**
     * Removes repeated words at the boundary between two
     * overlapping transcription results.
     */
    removeTranscriptOverlap(previousText, currentText) {
        if (!previousText || !currentText) {
            return currentText;
        }

        const previousWords = previousText
            .trim()
            .split(/\s+/)
            .filter(Boolean);

        const currentWords = currentText
            .trim()
            .split(/\s+/)
            .filter(Boolean);

        if (!previousWords.length || !currentWords.length) {
            return currentText;
        }

        const normalize = (word) => word
            .toLocaleLowerCase()
            .replace(
                /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
                ''
            );

        const previousNormalized = previousWords.map(normalize);
        const currentNormalized = currentWords.map(normalize);

        // Compare at most 12 words at the transition.
        const maxOverlap = Math.min(
            12,
            previousWords.length,
            currentWords.length
        );

        let overlapWords = 0;

        for (let count = maxOverlap; count > 0; count--) {
            const previousTail = previousNormalized.slice(-count);
            const currentHead = currentNormalized.slice(0, count);

            if (
                previousTail.every((word, index) => {
                    const current = currentHead[index];

                    // Empty words (punctuation) carry no information.
                    if (!word || !current) return true;

                    return word === current;
                })
            ) {
                overlapWords = count;
                break;
            }
        }

        return currentWords
            .slice(overlapWords)
            .join(' ')
            .trim();
    }

    /**
     * Builds the Wyoming transcribe configuration.
     */
    buildTranscribeData() {
        const w = this.config?.whisper || {};
        const data = {};

        if (w.language) data.language = w.language;

        if (
            Array.isArray(w.temperature) &&
            w.temperature.length > 0
        ) {
            data.temperature = w.temperature;
        }

        if (w.prompt) data.prompt = w.prompt;

        data.translate = Boolean(w.translate);

        if (Number.isInteger(w.beamSize)) {
            data.beam_size = w.beamSize;
        }

        if (Number.isInteger(w.bestOf)) {
            data.best_of = w.bestOf;
        }

        if (typeof w.patience === 'number') {
            data.patience = w.patience;
        }

        if (typeof w.lengthPenalty === 'number') {
            data.length_penalty = w.lengthPenalty;
        }

        if (typeof w.repetitionPenalty === 'number') {
            data.repetition_penalty = w.repetitionPenalty;
        }

        if (typeof w.compressionRatioThreshold === 'number') {
            data.compression_ratio_threshold =
                w.compressionRatioThreshold;
        }

        if (typeof w.logProbThreshold === 'number') {
            data.log_prob_threshold = w.logProbThreshold;
        }

        if (typeof w.noSpeechThreshold === 'number') {
            data.no_speech_threshold = w.noSpeechThreshold;
        }

        data.condition_on_previous_text =
            Boolean(w.conditionOnPreviousText);

        if (w.initialPrompt) {
            data.initial_prompt = w.initialPrompt;
        }

        if (w.hotwords) {
            data.hotwords = w.hotwords;
        }

        // Enable VAD only when explicitly requested.
        data.vad_filter = Boolean(w.vadFilter);

        if (data.vad_filter) {
            data.vad_parameters =
                (w.vadParameters && typeof w.vadParameters === 'object')
                    ? w.vadParameters
                    : {};
        }

        return data;
    }

    /**
     * Filters configured badwords from the transcript.
     */
    filterBadwords(text) {
        const badwords = this.config?.badwords || [];

        if (!badwords.length || !text) {
            return text;
        }

        let result = text;

        for (const word of badwords) {
            if (!word) continue;

            const escaped = String(word).replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
            );

            result = result.replace(
                new RegExp(escaped, 'gi'),
                ''
            );
        }

        return result.replace(/\s+/g, ' ').trim();
    }

    /**
     * Transcribes raw PCM through Wyoming TCP.
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

                try {
                    client.destroy();
                } catch {
                    // Ignore cleanup errors.
                }

                if (err) {
                    reject(err);
                } else {
                    resolve(value);
                }
            };

            const timer = setTimeout(() => {
                finish(
                    new Error(
                        `Wyoming-Timeout nach ${WYOMING_TIMEOUT_MS}ms`
                    )
                );
            }, WYOMING_TIMEOUT_MS);

            client.on('connect', () => {
                const fmt = {
                    rate: SAMPLE_RATE,
                    width: WIDTH,
                    channels: CHANNELS
                };

                const sendMsg = (obj, payload) => {
                    if (payload) {
                        obj = {
                            ...obj,
                            payload_length: payload.length
                        };
                    }

                    client.write(
                        Buffer.from(
                            JSON.stringify(obj) + '\n',
                            'utf8'
                        )
                    );

                    if (payload) {
                        client.write(payload);
                    }
                };

                sendMsg({
                    type: 'transcribe',
                    data: this.buildTranscribeData()
                });

                sendMsg({
                    type: 'audio-start',
                    data: fmt
                });

                sendMsg({
                    type: 'audio-chunk',
                    data: fmt
                }, pcm);

                sendMsg({
                    type: 'audio-stop'
                });
            });

            let buf = Buffer.alloc(0);

            client.on('data', (chunk) => {
                buf = Buffer.concat([buf, chunk]);

                while (true) {
                    const nl = buf.indexOf('\n');

                    if (nl === -1) break;

                    const line = buf
                        .slice(0, nl)
                        .toString('utf8');

                    let msg;

                    try {
                        msg = JSON.parse(line);
                    } catch {
                        buf = buf.slice(nl + 1);
                        continue;
                    }

                    // Wyoming framing:
                    // Header + data_length JSON + payload_length binary.
                    const dataLen = msg.data_length || 0;
                    const payloadLen = msg.payload_length || 0;

                    const need = nl + 1 + dataLen + payloadLen;

                    if (buf.length < need) break;

                    buf = buf.slice(nl + 1);

                    if (dataLen > 0) {
                        const dataJson = buf
                            .slice(0, dataLen)
                            .toString('utf8');

                        buf = buf.slice(dataLen);

                        try {
                            msg.data = JSON.parse(dataJson);
                        } catch {
                            // Ignore malformed optional JSON.
                        }
                    }

                    if (payloadLen > 0) {
                        buf = buf.slice(payloadLen);
                    }

                    if (msg.type === 'transcript') {
                        finish(
                            null,
                            (msg.data && msg.data.text) || ''
                        );
                        return;
                    }

                    if (msg.type === 'error') {
                        finish(
                            new Error(
                                msg.data?.message || 'Wyoming-Fehler'
                            )
                        );
                        return;
                    }
                }
            });

            client.on('error', (err) => finish(err));

            client.on('close', () => {
                finish(
                    new Error('Wyoming-Verbindung geschlossen')
                );
            });
        });
    }

    /**
     * Invokes the optional onTranscription callback.
     * Errors are logged but never break the transcription flow.
     */
    notifyTranscription() {
        if (typeof this.onTranscription !== 'function') {
            return;
        }

        try {
            this.onTranscription();
        } catch (err) {
            this.logger.error(
                this.label,
                'onTranscription-Callback fehlgeschlagen',
                { error: err.message }
            );
        }
    }

    /**
     * Sends JSON only if the WebSocket is open.
     */
    safeSend(ws, obj) {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    /**
     * Closes all clients and the WebSocket server.
     */
    close() {
        for (const ws of this.clients) {
            try {
                ws.close();
            } catch {
                // Ignore cleanup errors.
            }
        }

        this.clients.clear();
        this.wss.close();
    }
}

export { TranscribeBridge };
