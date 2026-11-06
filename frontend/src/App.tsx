import { useEffect, useRef, useState } from "react";
import {
  createUpload,
  fetchGreeting,
  processAudio,
  uploadToS3,
  type ChatTurn,
  type InvestigationScope,
} from "./api";
import { getApiEndpoint, setApiEndpoint } from "./config";
import ResourceScope, { type SelectedScope } from "./ResourceScope";

type Phase =
  | "idle"
  | "recording"
  | "uploading"
  | "thinking"
  | "speaking"
  | "error";

type ConversationTurn = {
  id: string;
  transcript: string;
  replyText: string;
  replyAudioUrl: string;
};

const SPEECH_RMS = 0.018;
const SILENCE_MS = 1300;
const MIN_SPEECH_MS = 500;
const MAX_RECORD_MS = 28_000;

const TRY_SAYING = [
  "Why is my Lambda failing?",
  "Are any CloudWatch alarms firing?",
  "List my Lambda functions",
  "Check timeouts on ProcessAudio",
];

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const type of candidates) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(type)
    ) {
      return type;
    }
  }
  return "audio/webm";
}

function rmsFromAnalyser(analyser: AnalyserNode, buffer: Uint8Array): number {
  analyser.getByteTimeDomainData(buffer as Uint8Array<ArrayBuffer>);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const v = (buffer[i]! - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buffer.length);
}

function phaseLabel(phase: Phase, seconds: string): string {
  switch (phase) {
    case "idle":
      return "Ready";
    case "recording":
      return `Listening · ${seconds}s`;
    case "uploading":
      return "Uploading voice";
    case "thinking":
      return "Investigating account";
    case "speaking":
      return "Probe speaking";
    case "error":
      return "Error";
  }
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [selectedScope, setSelectedScope] = useState<SelectedScope | null>(
    null,
  );
  const [apiUrlInput, setApiUrlInput] = useState(() => getApiEndpoint());
  const [apiConfigured, setApiConfigured] = useState(
    () => Boolean(getApiEndpoint()),
  );
  const selectedScopeRef = useRef<SelectedScope | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const mimeTypeRef = useRef("audio/webm");
  const timerRef = useRef<number | null>(null);
  const vadRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const sessionRef = useRef(false);
  const historyRef = useRef<ChatTurn[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const replyAudioRef = useRef<HTMLAudioElement | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const processGenerationRef = useRef(0);

  useEffect(() => {
    return () => {
      teardownSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, phase]);

  useEffect(() => {
    selectedScopeRef.current = selectedScope;
  }, [selectedScope]);

  function toInvestigationScope(
    scope: SelectedScope | null,
  ): InvestigationScope | null {
    if (!scope) return null;
    return {
      type: scope.type,
      name: scope.resource.name,
      id: scope.resource.id,
      region: scope.region,
      arn: scope.resource.arn,
    };
  }

  function clearTimers() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (vadRef.current) {
      window.clearInterval(vadRef.current);
      vadRef.current = null;
    }
  }

  function teardownSession() {
    sessionRef.current = false;
    processGenerationRef.current += 1;
    clearTimers();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    mediaRecorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    analyserRef.current = null;
    if (replyAudioRef.current) {
      replyAudioRef.current.pause();
      replyAudioRef.current.removeAttribute("src");
    }
  }

  async function ensureMic(): Promise<MediaStream> {
    if (streamRef.current?.active) return streamRef.current;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streamRef.current = stream;
    mimeTypeRef.current = pickMimeType();

    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    audioCtxRef.current = ctx;
    analyserRef.current = analyser;

    return stream;
  }

  function beginListening() {
    if (!sessionRef.current || !streamRef.current) return;

    const mimeType = mimeTypeRef.current;
    const recorder = new MediaRecorder(streamRef.current, { mimeType });
    chunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };

    recorder.onstop = () => {
      void handleUtterance(mimeType);
    };

    mediaRecorderRef.current = recorder;
    recorder.start(250);
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setPhase("recording");
    setError(null);

    clearTimers();
    timerRef.current = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 200);

    const analyser = analyserRef.current;
    if (!analyser) return;

    const buffer = new Uint8Array(analyser.fftSize);
    let heardSpeech = false;
    let speechStartedAt = 0;
    let silenceStartedAt: number | null = null;

    vadRef.current = window.setInterval(() => {
      if (!sessionRef.current) return;
      const now = Date.now();
      const elapsed = now - startedAtRef.current;
      const level = rmsFromAnalyser(analyser, buffer);

      if (elapsed >= MAX_RECORD_MS) {
        stopListening();
        return;
      }

      if (!heardSpeech) {
        if (level >= SPEECH_RMS) {
          heardSpeech = true;
          speechStartedAt = now;
          silenceStartedAt = null;
        }
        return;
      }

      if (level >= SPEECH_RMS) {
        silenceStartedAt = null;
        return;
      }

      if (silenceStartedAt === null) {
        silenceStartedAt = now;
        return;
      }

      const spokenLongEnough = now - speechStartedAt >= MIN_SPEECH_MS;
      const silentLongEnough = now - silenceStartedAt >= SILENCE_MS;
      if (spokenLongEnough && silentLongEnough) {
        stopListening();
      }
    }, 80);
  }

  function stopListening() {
    clearTimers();
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  }

  async function handleUtterance(mimeType: string) {
    if (!sessionRef.current) return;

    const generation = processGenerationRef.current;
    const blob = new Blob(chunksRef.current, {
      type: mimeType.split(";")[0],
    });
    chunksRef.current = [];

    if (blob.size < 800) {
      beginListening();
      return;
    }

    setPhase("uploading");

    try {
      const { uploadUrl, objectKey, contentType: signedType } =
        await createUpload(mimeType);
      if (!sessionRef.current || generation !== processGenerationRef.current) {
        return;
      }

      await uploadToS3(uploadUrl, blob, signedType);
      if (!sessionRef.current || generation !== processGenerationRef.current) {
        return;
      }

      setPhase("thinking");
      const history = historyRef.current;
      const response = await processAudio(
        objectKey,
        history,
        toInvestigationScope(selectedScopeRef.current),
      );
      if (!sessionRef.current || generation !== processGenerationRef.current) {
        return;
      }

      historyRef.current = [
        ...history,
        { role: "user", content: response.transcript },
        { role: "assistant", content: response.replyText },
      ];

      const turn: ConversationTurn = {
        id: crypto.randomUUID(),
        transcript: response.transcript,
        replyText: response.replyText,
        replyAudioUrl: response.replyAudioUrl,
      };
      setTurns((prev) => [...prev, turn]);
      setPhase("speaking");
      await playReply(response.replyAudioUrl);

      if (!sessionRef.current || generation !== processGenerationRef.current) {
        return;
      }

      beginListening();
    } catch (err) {
      if (!sessionRef.current || generation !== processGenerationRef.current) {
        return;
      }
      const message = err instanceof Error ? err.message : "Request failed";
      setError(message);
      setPhase("error");
      sessionRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      void audioCtxRef.current?.close().catch(() => undefined);
      audioCtxRef.current = null;
      analyserRef.current = null;
    }
  }

  function playReply(url: string): Promise<void> {
    return new Promise((resolve) => {
      const audio = replyAudioRef.current;
      if (!audio) {
        resolve();
        return;
      }

      const finish = () => {
        audio.removeEventListener("ended", finish);
        audio.removeEventListener("error", finish);
        resolve();
      };

      audio.addEventListener("ended", finish);
      audio.addEventListener("error", finish);
      audio.src = url;
      audio.load();
      void audio.play().catch(() => {
        window.setTimeout(finish, 400);
      });
    });
  }

  async function startConversation() {
    setError(null);
    setTurns([]);
    historyRef.current = [];
    sessionRef.current = true;
    const generation = ++processGenerationRef.current;

    try {
      await ensureMic();
      if (audioCtxRef.current?.state === "suspended") {
        await audioCtxRef.current.resume();
      }

      setPhase("thinking");
      const greet = await fetchGreeting(
        toInvestigationScope(selectedScopeRef.current),
      );
      if (!sessionRef.current || generation !== processGenerationRef.current) {
        return;
      }

      historyRef.current = [{ role: "assistant", content: greet.replyText }];
      setTurns([
        {
          id: crypto.randomUUID(),
          transcript: "",
          replyText: greet.replyText,
          replyAudioUrl: greet.replyAudioUrl,
        },
      ]);
      setPhase("speaking");
      await playReply(greet.replyAudioUrl);

      if (!sessionRef.current || generation !== processGenerationRef.current) {
        return;
      }
      beginListening();
    } catch (err) {
      sessionRef.current = false;
      const message =
        err instanceof Error ? err.message : "Microphone permission denied";
      setError(message);
      setPhase("error");
    }
  }

  function endConversation() {
    teardownSession();
    setPhase("idle");
    setElapsedMs(0);
  }

  function clearTranscript() {
    setTurns([]);
    historyRef.current = [];
  }

  function resumeAfterError() {
    setError(null);
    void startConversation();
  }

  function saveApiUrl() {
    const cleaned = apiUrlInput.trim().replace(/\/$/, "");
    setApiEndpoint(cleaned);
    setApiUrlInput(cleaned);
    setApiConfigured(Boolean(cleaned));
    setError(null);
  }

  const seconds = (elapsedMs / 1000).toFixed(1);
  const busy = phase === "uploading" || phase === "thinking";
  const inSession =
    phase === "recording" ||
    phase === "uploading" ||
    phase === "thinking" ||
    phase === "speaking";
  const hasTranscript = turns.length > 0;
  const showLanding = !inSession && !hasTranscript && phase !== "error";

  return (
    <div className={`app ${showLanding ? "app-landing" : "app-session"}`}>
      {showLanding ? (
        <section className="landing">
          <aside className="landing-hero">
            <div className="hero-glow" aria-hidden="true" />
            <p className="brand">Probe 2.0</p>
            <h1>Same Probe brain. Now you talk instead of type.</h1>
            <p className="lede">
              Speak an AWS issue. Probe investigates your account with
              read-only evidence — Lambda, alarms, logs — then answers out
              loud.
            </p>
            <ul className="hero-points">
              <li>Deep RCA for Lambda via CloudWatch</li>
              <li>Alarms, stacks, and resource lists</li>
              <li>Continuous voice conversation</li>
            </ul>
          </aside>

          <div className="landing-panel">
            <div
              className="config-status"
              data-ready={apiConfigured ? "true" : "false"}
            >
              <span className="status-dot" />
              <span className="status-text">
                {apiConfigured
                  ? "API connected"
                  : "Paste your backend API URL below"}
              </span>
            </div>

            <label className="api-field">
              <span>Backend API URL</span>
              <div className="api-row">
                <input
                  type="url"
                  value={apiUrlInput}
                  placeholder="https://xxxx.execute-api.us-east-1.amazonaws.com"
                  onChange={(e) => setApiUrlInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveApiUrl();
                  }}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={saveApiUrl}
                >
                  Save
                </button>
              </div>
              <span className="api-help">
                Use the <code>ApiEndpoint</code> output from{" "}
                <code>sam deploy</code> (no trailing slash).
              </span>
            </label>

            <h2 className="panel-title">Start a voice investigation</h2>
            <p className="panel-copy">
              Pause when you finish a thought. Probe replies, then keeps
              listening until you end the session. Pick a resource target
              inside the voice session.
            </p>

            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={startConversation}
              disabled={!apiConfigured}
            >
              Start talking
            </button>

            <div className="try-block">
              <p className="try-label">Try saying</p>
              <ul className="try-list">
                {TRY_SAYING.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>

            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </section>
      ) : (
        <section className="session">
          <header className="topbar">
            <div className="topbar-brand">
              <span className="brand">Probe 2.0</span>
              <span className="topbar-meta">voice edition</span>
            </div>
            <div className="topbar-actions">
              <span
                className={`conn-pill ${inSession ? "conn-pill-live" : ""}`}
              >
                {inSession ? "live" : "paused"}
              </span>
              {hasTranscript ? (
                <button
                  type="button"
                  className="text-btn"
                  onClick={clearTranscript}
                >
                  Clear
                </button>
              ) : null}
              <button
                type="button"
                className="text-btn"
                onClick={endConversation}
              >
                End
              </button>
            </div>
          </header>

          <div className="session-body session-body-three">
            <aside className="voice-rail">
              <div
                className={`mic-stage ${phase === "recording" ? "mic-live" : ""} ${busy ? "mic-busy" : ""} ${phase === "speaking" ? "mic-speak" : ""}`}
              >
                <div className="mic-orb" aria-hidden="true">
                  <span className="mic-bars">
                    <span />
                    <span />
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
                <p className="mic-status">{phaseLabel(phase, seconds)}</p>
                {selectedScope ? (
                  <p className="mic-hint">
                    Target: {selectedScope.resource.name}
                  </p>
                ) : null}
                {phase === "recording" ? (
                  <p className="mic-hint">
                    Pause briefly — Probe will answer on its own.
                  </p>
                ) : null}
                {phase === "thinking" ? (
                  <p className="mic-hint">
                    Checking Lambda, logs, metrics, and alarms…
                  </p>
                ) : null}
              </div>

              <div className="rail-actions">
                {phase === "recording" ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    onClick={stopListening}
                  >
                    I&apos;m done speaking
                  </button>
                ) : null}

                {phase === "idle" || phase === "error" ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    onClick={phase === "error" ? resumeAfterError : startConversation}
                    disabled={!apiConfigured}
                  >
                    {phase === "error" ? "Try again" : "Resume listening"}
                  </button>
                ) : null}

                {busy || phase === "speaking" ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-block"
                    disabled
                  >
                    Working…
                  </button>
                ) : null}
              </div>

              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </aside>

            <aside className="scope-rail" aria-label="Resource scope">
              <ResourceScope
                selected={selectedScope}
                onSelect={setSelectedScope}
                disabled={busy}
              />
            </aside>

            <main className="transcript" aria-label="Investigation transcript">
              <div className="transcript-head">
                <h2>Transcript</h2>
                <span className="transcript-count">
                  {turns.length} turn{turns.length === 1 ? "" : "s"}
                </span>
              </div>

              {!hasTranscript ? (
                <div className="transcript-empty">
                  <p>
                    {selectedScope
                      ? `Ask about ${selectedScope.resource.name}.`
                      : "Pick a resource in Scope, then speak your AWS issue."}
                  </p>
                </div>
              ) : (
                <div className="transcript-stream">
                  {turns.map((turn) => (
                    <article key={turn.id} className="exchange">
                      {turn.transcript ? (
                        <div className="bubble bubble-you">
                          <p className="bubble-label">You</p>
                          <p className="bubble-copy">{turn.transcript}</p>
                        </div>
                      ) : null}
                      <div className="bubble bubble-probe">
                        <p className="bubble-label">Probe</p>
                        <p className="bubble-copy">{turn.replyText}</p>
                      </div>
                    </article>
                  ))}
                  <div ref={conversationEndRef} />
                </div>
              )}
            </main>
          </div>
        </section>
      )}

      <audio ref={replyAudioRef} preload="auto" className="sr-only" />
    </div>
  );
}
