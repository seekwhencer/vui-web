import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, Square, Trash2 } from 'lucide-react';
import workletUrl from './audio-capture-worklet.js?url';

const WS_PATH = '/transcribe';
const RECONNECT_MS = 3000;
const SAMPLE_RATE = 16000;

function buildWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}${WS_PATH}`;
}

export default function App() {
  const { t } = useTranslation();

  const socketRef = useRef(null);
  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const transcriptRef = useRef(null);

  const [status, setStatus] = useState('disconnected');
  const [isRecording, setIsRecording] = useState(false);
  const [finalText, setFinalText] = useState('');
  const [interimText, setInterimText] = useState('');

  const stopRecording = useCallback(() => {
    const ctx = audioContextRef.current;
    if (ctx && ctx.state !== 'closed') {
      ctx.close().catch(() => { });
    }
    audioContextRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsRecording(false);
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      setStatus('ready');
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
        },
      });
      streamRef.current = stream;

      // 16kHz-AudioContext: der Worklet liefert dadurch 16kHz-Mono-PCM,
      // genau das Format, das die Server-Bridge in WAV verpackt.
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = ctx;
      await ctx.audioWorklet.addModule(workletUrl);

      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-capture');
      const mute = ctx.createGain();
      mute.gain.value = 0; // Feedback vermeiden, Worklet wird trotzdem "gezogen"

      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);

      node.port.onmessage = (event) => {
        const socket = socketRef.current;
        const pcm = event.data; // ArrayBuffer (Int16, Mono)
        if (pcm && pcm.byteLength > 0 && socket && socket.readyState === WebSocket.OPEN) {
          socket.send(pcm);
        }
      };

      setIsRecording(true);
      setStatus('recording');
    } catch (err) {
      console.error('Mikrofon-Zugriff fehlgeschlagen:', err);
      window.alert(t('transcription.micDenied'));
    }
  }, [t]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer = null;
    let socket = null;

    const connect = () => {
      socket = new WebSocket(buildWsUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        if (!disposed) setStatus('ready');
      };

      socket.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!data) return;

        if (data.error) {
          setStatus('error');
          return;
        }
        if (!data.text) return;

        if (data.isFinal) {
          setFinalText((prev) => prev + data.text + ' ');
          setInterimText('');
        } else {
          setInterimText(data.text);
        }
      };

      socket.onclose = () => {
        if (disposed) return;
        setStatus('disconnected');
        stopRecording();
        reconnectTimer = setTimeout(connect, RECONNECT_MS);
      };

      socket.onerror = () => {
        if (!disposed) setStatus('error');
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
      socketRef.current = null;
    };
  }, [stopRecording]);

  useEffect(() => {
    const box = transcriptRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [finalText, interimText]);

  const clearTranscript = () => {
    setFinalText('');
    setInterimText('');
  };

  const showPlaceholder = !finalText && !interimText;

  return (
    <div className="transcription-page">
      <div className="transcription">
        <div className="transcription__header">
          <div className={`status-badge status-badge--${status}`}>
            <span className="status-badge__dot" />
            <span>{t(`status.${status}`)}</span>
          </div>
          <h2>{t('transcription.title')}</h2>
        </div>

        <div className="transcription__controls">
          <button
            type="button"
            className={`btn btn--primary${isRecording ? ' is-recording' : ''}`}
            onClick={() => (isRecording ? stopRecording() : startRecording())}
          >
            {isRecording ? <Square size={20} /> : <Mic size={20} />}
            <span>{isRecording ? t('transcription.stop') : t('transcription.start')}</span>
          </button>
          <button type="button" className="btn btn--secondary" onClick={clearTranscript}>
            <Trash2 size={20} />
            <span>{t('transcription.clear')}</span>
          </button>
        </div>

        <div className="transcript" ref={transcriptRef}>
          {showPlaceholder && (
            <p className="transcript__placeholder">{t('transcription.placeholder')}</p>
          )}
          <span>{finalText}</span>
          <span className="transcript__interim">{interimText}</span>
        </div>
      </div>
    </div>
  );
}
