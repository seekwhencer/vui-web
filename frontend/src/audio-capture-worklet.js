// AudioWorklet: läuft im Audio-Thread, liefert rohe PCM-Samples (Int16, Mono)
// an den Main-Thread. Muss selbstständig sein (kein Import) — wird via
// `audioContext.audioWorklet.addModule(url)` geladen.
class PcmCaptureProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        const channel = input[0];
        if (!channel || channel.length === 0) return true;

        // Float32 (-1..1) → Int16 PCM
        const int16 = new Int16Array(channel.length);
        for (let i = 0; i < channel.length; i++) {
            const s = Math.max(-1, Math.min(1, channel[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        this.port.postMessage(int16.buffer, [int16.buffer]);
        return true;
    }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
