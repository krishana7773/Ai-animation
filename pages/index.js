// pages/index.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import Lottie from "lottie-react";
import Head from "next/head";
import animationData from "../public/animation.json";
import styles from "../styles/Home.module.css";

/* =========================
   CONFIGURATION (tweak)
   ========================= */
const CONFIG = {
  FFT_SIZE: 1024,
  ENV_ATTACK: 0.25,
  ENV_RELEASE: 0.95,
  DB_MIN: -72,
  DB_MAX: -12,
  AUTO_GAIN_DECAY: 0.995,
  DESIRED_PEAK: 0.6,
  HYSTERESIS_START_FRAMES: 3,
  HYSTERESIS_STOP_FRAMES: 12,
  START_THRESHOLD: 0.12,
  STOP_THRESHOLD: 0.07,
  LOTTIE_LERP_T: 0.12,
  INACTIVITY_SLEEP_MS: 800,
  AUTO_GAIN_MIN: 1e-4,
  AUTO_GAIN_MAX: 10,

  // pitch detection
  pitchMinHz: 70,
  pitchMaxHz: 500,
  pitchSmooth: 0.85,
  pitchWeight: 0.35,

  // silence gating
  SILENCE_THRESHOLD: 0.02,
  SILENCE_FRAMES: 6,
  RUNNING_PEAK_DECAY_ON_SILENCE: 0.98,
  PITCH_GATE_THRESHOLD: 0.04,

  // bias + pitch-boost tuning (new)
  BASELINE: 0.10,          // keep orb at least at ~3/10
  EXPONENT: 999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999.0,           // compresses mid values downward
  PITCH_THRESHOLD: 0.99,   // pitch must be above this normalized to activate boost
  MAX_PITCH_BOOST: 0.0,   // maximum additive boost from pitch (0..1)
  PITCH_ACTIVATION_EASE: false, // smoothstep easing for pitch activation
};

/* =========================
   Utilities
   ========================= */
function rmsFromTimeDomain(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const v = buffer[i];
    sum += v * v;
  }
  return Math.sqrt(sum / buffer.length);
}
function rmsToDb(rms) {
  const min = 1e-8;
  return 20 * Math.log10(Math.max(rms, min));
}
function dbToNormalized(db, minDb = CONFIG.DB_MIN, maxDb = CONFIG.DB_MAX) {
  const clamped = Math.max(minDb, Math.min(maxDb, db));
  return (clamped - minDb) / (maxDb - minDb);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function bandEnergyFromByteArray(byteArray, startBin, endBin) {
  let sum = 0;
  const count = Math.max(1, endBin - startBin + 1);
  for (let i = startBin; i <= endBin && i < byteArray.length; i++) {
    sum += byteArray[i];
  }
  return (sum / count) / 255;
}
function getSharedAudioContext() {
  if (typeof window === "undefined") return null;
  if (!window.__AI_ORB_AUDIO_CTX) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    window.__AI_ORB_AUDIO_CTX = new AC();
  }
  return window.__AI_ORB_AUDIO_CTX;
}

/* =========================
   Pitch detection (autocorrelation)
   ========================= */
function getPitchFromTimeDomain(buffer, sampleRate, minHz = CONFIG.pitchMinHz, maxHz = CONFIG.pitchMaxHz) {
  const SIZE = buffer.length;
  // quiet check
  let rms = 0;
  for (let i = 0; i < SIZE; i++) {
    const v = buffer[i];
    rms += v * v;
  }
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.001) return null;

  // autocorrelation
  const autocorr = new Float32Array(SIZE);
  for (let lag = 0; lag < SIZE; lag++) {
    let sum = 0;
    for (let i = 0; i < SIZE - lag; i++) {
      sum += buffer[i] * buffer[i + lag];
    }
    autocorr[lag] = sum;
  }

  // find peak in lag range for minHz..maxHz
  const maxLag = Math.floor(sampleRate / minHz);
  const minLag = Math.floor(sampleRate / maxHz);
  const start = Math.max(0, minLag);
  let peakIndex = -1;
  let peakValue = -Infinity;
  for (let i = start; i <= Math.min(maxLag, SIZE - 2); i++) {
    if (autocorr[i] > peakValue) {
      peakValue = autocorr[i];
      peakIndex = i;
    }
  }
  if (peakIndex <= 0 || peakValue <= 0) return null;

  // parabolic interpolation
  const x0 = peakIndex - 1 >= 0 ? autocorr[peakIndex - 1] : 0;
  const x1 = autocorr[peakIndex];
  const x2 = peakIndex + 1 < autocorr.length ? autocorr[peakIndex + 1] : 0;
  const denom = x0 - 2 * x1 + x2;
  const shift = denom === 0 ? 0 : (x0 - x2) / (2 * denom);
  const peakLag = peakIndex + shift;
  const freq = sampleRate / peakLag;
  if (!isFinite(freq) || freq <= 0) return null;
  if (freq < minHz || freq > maxHz) return null;
  return freq;
}

/* =========================
   Component
   ========================= */
export default function Home() {
  // Lottie refs
  const coreLottieRef = useRef(null);
  const dotsLottieRef = useRef(null);

  // UI state
  const [aiState, setAiState] = useState("listening");
  const [breathRange, setBreathRange] = useState(0);
  const [remoteUrl, setRemoteUrl] = useState("");

  // debug overlay values
  const [debugValues, setDebugValues] = useState({
    combined: 0,
    pitchNorm: 0,
    biased: 0,
    pitchActivation: 0,
    final: 0,
  });

  // split lottie layers
  const coreAnimationData = useMemo(
    () => ({ ...animationData, layers: animationData.layers.filter((l) => l.nm !== "audio dots") }),
    [],
  );
  const dotsAnimationData = useMemo(
    () => ({ ...animationData, layers: animationData.layers.filter((l) => l.nm === "audio dots") }),
    [],
  );

  // derived visuals
  const normalized = breathRange / 10;
  const breathScale = 1 + normalized * 0.5;
  const dotsOpacity = normalized;
  const dotsScale = 0.6 + normalized * 0.4;
  const targetLottieSpeed = 0.3 + normalized * 1.7;
  const currentSpeedRef = useRef(0.3);

  // audio analysis refs
  const audioRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const rafRef = useRef(null);
  const lastActiveAtRef = useRef(Date.now());
  const timeDomainBufferRef = useRef(null);
  const frequencyByteArrayRef = useRef(null);

  // processing refs
  const envRef = useRef(0);
  const runningPeakRef = useRef(0.001);
  const startCounterRef = useRef(0);
  const stopCounterRef = useRef(0);
  const sleepingRef = useRef(false);
  const pitchSmoothedRef = useRef(null);
  const silenceCounterRef = useRef(0);

  /* -------------------------
     Lerp Lottie speed loop
     ------------------------- */
  useEffect(() => {
    let rafId = null;
    function step() {
      const t = CONFIG.LOTTIE_LERP_T;
      currentSpeedRef.current = lerp(currentSpeedRef.current, targetLottieSpeed, t);
      if (dotsLottieRef.current?.setSpeed) dotsLottieRef.current.setSpeed(currentSpeedRef.current);
      rafId = requestAnimationFrame(step);
    }
    rafId = requestAnimationFrame(step);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [targetLottieSpeed]);

  /* -------------------------
     Attach analyser to <audio>
     ------------------------- */
  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl || !remoteUrl) return;

    function cleanupGraph() {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      try { sourceRef.current?.disconnect(); } catch (e) {}
      try { analyserRef.current?.disconnect(); } catch (e) {}
      sourceRef.current = null;
      analyserRef.current = null;
    }

    audioEl.src = remoteUrl;
    audioEl.crossOrigin = "anonymous";

    const audioCtx = getSharedAudioContext();
    if (!audioCtx) {
      console.warn("WebAudio not supported");
      return;
    }

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = CONFIG.FFT_SIZE;
    analyserRef.current = analyser;

    try {
      const source = audioCtx.createMediaElementSource(audioEl);
      sourceRef.current = source;
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch (err) {
      console.error("createMediaElementSource failed (CORS?)", err);
      cleanupGraph();
      return;
    }

    const bufferLen = analyser.fftSize;
    timeDomainBufferRef.current = new Float32Array(bufferLen);
    frequencyByteArrayRef.current = new Uint8Array(analyser.frequencyBinCount);

    let cancelled = false;

    const sampleRate = audioCtx.sampleRate;
    const nyquist = sampleRate / 2;
    const binCount = analyser.frequencyBinCount;
    function binToFreq(binIndex) { return (binIndex / binCount) * nyquist; }

    // precompute bins for bands
    let bassStart = 0, bassEnd = 0, midStart = 0, midEnd = 0, trebleStart = 0;
    for (let i = 0; i < binCount; i++) {
      const f = binToFreq(i);
      if (f >= 20 && bassStart === 0) bassStart = i;
      if (f <= 250) bassEnd = i;
      if (f >= 251 && midStart === 0) midStart = i;
      if (f <= 2000) midEnd = i;
    }
    bassStart = Math.max(0, bassStart || 0);
    bassEnd = Math.max(bassStart, bassEnd || Math.floor(binCount * 0.15));
    midStart = Math.max(bassEnd + 1, midStart || Math.floor(binCount * 0.15));
    midEnd = Math.max(midStart, midEnd || Math.floor(binCount * 0.5));
    trebleStart = Math.max(midEnd + 1, trebleStart || 0);

    function analyseLoop() {
      if (cancelled) return;

      analyser.getFloatTimeDomainData(timeDomainBufferRef.current);
      const rms = rmsFromTimeDomain(timeDomainBufferRef.current);
      const db = rmsToDb(rms);
      let normalizedDb = dbToNormalized(db, CONFIG.DB_MIN, CONFIG.DB_MAX);

      // auto-peak update
      runningPeakRef.current = Math.max(runningPeakRef.current * CONFIG.AUTO_GAIN_DECAY, normalizedDb, CONFIG.AUTO_GAIN_MIN);
      const gain = runningPeakRef.current > CONFIG.AUTO_GAIN_MIN ? Math.min(CONFIG.AUTO_GAIN_MAX, CONFIG.DESIRED_PEAK / runningPeakRef.current) : 1;
      const gained = Math.min(1, normalizedDb * gain);

      // envelope attack/release
      const env = envRef.current;
      if (gained > env) envRef.current = CONFIG.ENV_ATTACK * env + (1 - CONFIG.ENV_ATTACK) * gained;
      else envRef.current = CONFIG.ENV_RELEASE * env + (1 - CONFIG.ENV_RELEASE) * gained;

      // band energies
      analyser.getByteFrequencyData(frequencyByteArrayRef.current);
      const bassEnergy = bandEnergyFromByteArray(frequencyByteArrayRef.current, bassStart, bassEnd);
      const midEnergy = bandEnergyFromByteArray(frequencyByteArrayRef.current, midStart, midEnd);
      const trebleEnergy = bandEnergyFromByteArray(frequencyByteArrayRef.current, trebleStart, frequencyByteArrayRef.current.length - 1);

      // pitch detection (time domain)
      let pitchHz = null;
      try {
        pitchHz = getPitchFromTimeDomain(timeDomainBufferRef.current, sampleRate, CONFIG.pitchMinHz, CONFIG.pitchMaxHz);
      } catch (e) {
        pitchHz = null;
      }

      // smooth pitch
      if (pitchHz && isFinite(pitchHz)) {
        if (!pitchSmoothedRef.current) pitchSmoothedRef.current = pitchHz;
        else pitchSmoothedRef.current = CONFIG.pitchSmooth * pitchSmoothedRef.current + (1 - CONFIG.pitchSmooth) * pitchHz;
      } else {
        if (pitchSmoothedRef.current) pitchSmoothedRef.current = CONFIG.pitchSmooth * pitchSmoothedRef.current;
      }

      // map pitch to 0..1
      let pitchNorm = 0;
      if (pitchSmoothedRef.current && isFinite(pitchSmoothedRef.current)) {
        const p = Math.max(CONFIG.pitchMinHz, Math.min(CONFIG.pitchMaxHz, pitchSmoothedRef.current));
        pitchNorm = (p - CONFIG.pitchMinHz) / (CONFIG.pitchMaxHz - CONFIG.pitchMinHz);
        pitchNorm = Math.max(0, Math.min(1, pitchNorm));
      } else {
        pitchNorm = 0;
      }

      // combine envelope and bands
      const presence = Math.max(envRef.current, midEnergy);
      const sizeFactor = Math.max(envRef.current, bassEnergy * 1.2);
      const combined = Math.min(1, lerp(sizeFactor, presence, 0.25));

      /* =========================
         SILENCE GATING
         ========================= */
      if (envRef.current < CONFIG.SILENCE_THRESHOLD) {
        silenceCounterRef.current += 1;
      } else {
        silenceCounterRef.current = 0;
      }
      const isSilent = silenceCounterRef.current >= CONFIG.SILENCE_FRAMES;

      /* =========================
         BIAS-TO-LOW + PITCH-BOOST
         ========================= */
      // 1) non-linear bias
      const biased = Math.pow(Math.max(0, combined), CONFIG.EXPONENT);

      // 2) pitch activation (0..1)
      let pitchActivation = 0;
      if (pitchNorm > CONFIG.PITCH_THRESHOLD) {
        pitchActivation = (pitchNorm - CONFIG.PITCH_THRESHOLD) / (1 - CONFIG.PITCH_THRESHOLD);
        pitchActivation = Math.max(0, Math.min(1, pitchActivation));
        if (CONFIG.PITCH_ACTIVATION_EASE) {
          // smoothstep for softer ramp
          const x = pitchActivation;
          pitchActivation = x * x * (3 - 2 * x);
        }
      } else {
        pitchActivation = 0;
      }

      // 3) pitch boost
      const pitchBoost = pitchActivation * CONFIG.MAX_PITCH_BOOST;
      let boosted = Math.min(1, biased + pitchBoost);

      // 4) baseline floor
      let finalCombined = Math.max(CONFIG.BASELINE, boosted);

      // If we detect silence, override finalCombined and decay running peak + clear pitch
      if (isSilent) {
        finalCombined = 0;
        runningPeakRef.current = Math.max(runningPeakRef.current * CONFIG.RUNNING_PEAK_DECAY_ON_SILENCE, CONFIG.AUTO_GAIN_MIN);
        pitchSmoothedRef.current = null;
        if (aiState !== "listening") {
          setAiState("listening");
          dotsLottieRef.current?.pause?.();
        }
      }

      // hysteresis + transitions
      if (finalCombined > CONFIG.START_THRESHOLD) startCounterRef.current += 1;
      else startCounterRef.current = 0;
      if (finalCombined < CONFIG.STOP_THRESHOLD) stopCounterRef.current += 1;
      else stopCounterRef.current = 0;

      if (startCounterRef.current >= CONFIG.HYSTERESIS_START_FRAMES && aiState !== "speaking") {
        setAiState("speaking");
        dotsLottieRef.current?.play?.();
      }
      if (stopCounterRef.current >= CONFIG.HYSTERESIS_STOP_FRAMES && aiState !== "listening") {
        setAiState("listening");
        dotsLottieRef.current?.pause?.();
      }

      // map to breathRange (0..10) with jump smoothing
      const newRange = Math.round(finalCombined * 10);
      setBreathRange((prev) => {
        const delta = newRange - prev;
        if (Math.abs(delta) > 4) return prev + Math.sign(delta) * 4;
        return newRange;
      });

      if (finalCombined > 0.01) lastActiveAtRef.current = Date.now();

      // update debug overlay state (safe — small frequent updates acceptable for debug)
      setDebugValues({
        combined: Number(combined.toFixed(3)),
        pitchNorm: Number(pitchNorm.toFixed(3)),
        biased: Number(biased.toFixed(3)),
        pitchActivation: Number(pitchActivation.toFixed(3)),
        final: Number(finalCombined.toFixed(3)),
      });

      rafRef.current = requestAnimationFrame(analyseLoop);
    }

    // audio event handlers
    const onPlay = async () => {
      try { if (audioCtx.state === "suspended") await audioCtx.resume(); } catch (e) {}
      envRef.current = 0;
      startCounterRef.current = 0;
      stopCounterRef.current = 0;
      lastActiveAtRef.current = Date.now();
      sleepingRef.current = false;
      if (!rafRef.current) rafRef.current = requestAnimationFrame(analyseLoop);
      setAiState("speaking");
      dotsLottieRef.current?.play?.();
    };
    const onPauseOrEnd = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setTimeout(() => {
        if (audioEl.paused || audioEl.ended) {
          setAiState("listening");
          dotsLottieRef.current?.pause?.();
          setBreathRange(0);
        }
      }, 120);
    };

    audioEl.addEventListener("play", onPlay);
    audioEl.addEventListener("pause", onPauseOrEnd);
    audioEl.addEventListener("ended", onPauseOrEnd);

    if (!audioEl.paused && !audioEl.ended) onPlay();

    let sleepInterval = setInterval(() => {
      if (!rafRef.current) return;
      const since = Date.now() - lastActiveAtRef.current;
      if (since > CONFIG.INACTIVITY_SLEEP_MS) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        sleepingRef.current = true;
      }
    }, 300);

    // cleanup
    return () => {
      cancelled = true;
      audioEl.removeEventListener("play", onPlay);
      audioEl.removeEventListener("pause", onPauseOrEnd);
      audioEl.removeEventListener("ended", onPauseOrEnd);
      if (sleepInterval) clearInterval(sleepInterval);
      cleanupGraph();
    };

    // helper references used in cleanupGraph and closures
    function cleanupGraph() {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      try { sourceRef.current?.disconnect(); } catch (e) {}
      try { analyserRef.current?.disconnect(); } catch (e) {}
      sourceRef.current = null;
      analyserRef.current = null;
    }
  }, [remoteUrl, aiState]);

  /* Helper: fetch remote audio as blob URL */
  async function attachRemoteUrlViaFetch(url, { withCredentials = false } = {}) {
    try {
      const resp = await fetch(url, { method: "GET", credentials: withCredentials ? "include" : "omit" });
      if (!resp.ok) throw new Error("Fetch failed: " + resp.status);
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      setRemoteUrl((old) => {
        if (old && old.startsWith("blob:") && old !== blobUrl) {
          try { URL.revokeObjectURL(old); } catch (e) {}
        }
        return blobUrl;
      });
    } catch (err) {
      console.error("attachRemoteUrlViaFetch failed:", err);
      setRemoteUrl(url);
    }
  }

  /* =========================
     TTS simulation (sustained, syllable-like)
     ========================= */
  const ttsSimRef = useRef({ raf: null, start: 0, speed: 0.3 });

  function speakTextWithSimulation(text) {
    if (!("speechSynthesis" in window)) {
      console.warn("speechSynthesis not supported");
      return;
    }
    if (window.speechSynthesis.speaking) window.speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(text);
    u.onstart = () => {
      setAiState("speaking");
      ttsSimRef.current.start = performance.now();
      if (ttsSimRef.current.raf) cancelAnimationFrame(ttsSimRef.current.raf);
      ttsSimRef.current.speed = currentSpeedRef.current || 0.3;

      const simulate = (t) => {
        const elapsed = (t - ttsSimRef.current.start) / 1000;
        const slowVar = 0.5 + 0.5 * Math.sin(elapsed * 0.12);
        const syllRate = 4.5 + 1.5 * slowVar;
        const mod = 0.45 + 0.55 * Math.abs(Math.sin(elapsed * syllRate * Math.PI));
        const jitter = 0.85 + 0.3 * (Math.sin(elapsed * 2.17) * 0.5 + Math.random() * 0.5);
        const baseline = 0.25;
        const level = Math.min(1, baseline + mod * jitter * 0.75);
        setBreathRange(Math.round(level * 10));
        const target = 0.3 + level * 1.7;
        ttsSimRef.current.speed = lerp(ttsSimRef.current.speed, target, CONFIG.LOTTIE_LERP_T);
        if (dotsLottieRef.current?.setSpeed) dotsLottieRef.current.setSpeed(ttsSimRef.current.speed);
        dotsLottieRef.current?.play?.();
        ttsSimRef.current.raf = requestAnimationFrame(simulate);
      };

      ttsSimRef.current.raf = requestAnimationFrame(simulate);
    };
    u.onend = () => {
      setAiState("listening");
      if (ttsSimRef.current.raf) {
        cancelAnimationFrame(ttsSimRef.current.raf);
        ttsSimRef.current.raf = null;
      }
      setBreathRange(0);
      if (dotsLottieRef.current?.setSpeed) dotsLottieRef.current.setSpeed(0.3);
      dotsLottieRef.current?.pause?.();
      pitchSmoothedRef.current = null;
    };
    speechSynthesis.speak(u);
  }

  /* Manual toggle */
  const handleToggleState = (state) => {
    setAiState(state);
    if (state === "speaking") dotsLottieRef.current?.play?.();
    else dotsLottieRef.current?.pause?.();
  };

  /* Cleanup on unmount */
  useEffect(() => {
    return () => {
      if (ttsSimRef.current.raf) cancelAnimationFrame(ttsSimRef.current.raf);
      if (remoteUrl && remoteUrl.startsWith("blob:")) {
        try { URL.revokeObjectURL(remoteUrl); } catch (e) {}
      }
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [remoteUrl]);

  /* =========================
     Render
     ========================= */
  return (
    <>
      <Head>
        <title>AI Orb — pitch/reactive with bias & debug</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>AI Orb</h1>
          <p className={styles.subtitle}>{aiState === "listening" ? "Listening…" : "Speaking…"}</p>
        </header>

        <div className={styles.orbContainer}>
          <div
            className={styles.breathCircle}
            style={{
              "--breath-scale": breathScale,
              "--breath-duration": aiState === "speaking" ? "1.2s" : "3s",
            }}
          />

          <div className={styles.lottieLayer}>
            <Lottie
              lottieRef={coreLottieRef}
              animationData={coreAnimationData}
              loop={true}
              autoplay={true}
              style={{ width: "100%", height: "100%" }}
            />
          </div>

          <div
            className={styles.dotsLayer}
            style={{
              opacity: aiState === "speaking" ? dotsOpacity : 0,
              transform: `scale(${aiState === "speaking" ? dotsScale : 0.5})`,
            }}
          >
            <Lottie
              lottieRef={dotsLottieRef}
              animationData={dotsAnimationData}
              loop={false}
              autoplay={false}
              style={{ width: "100%", height: "100%" }}
            />
          </div>
        </div>

        {/* Controls */}
        <div className={styles.controls}>
          <button
            className={`${styles.controlBtn} ${aiState === "listening" ? styles.controlBtnListening : ""}`}
            onClick={() => handleToggleState("listening")}
          >
            <span className={styles.controlIcon}>🎤</span> Listening
          </button>

          <button
            className={`${styles.controlBtn} ${aiState === "speaking" ? styles.controlBtnSpeaking : ""}`}
            onClick={() => handleToggleState("speaking")}
          >
            <span className={styles.controlIcon}>🔊</span> Speaking
          </button>

          <button
            className={styles.controlBtn}
            onClick={() => speakTextWithSimulation("This is a demo of the improved AI orb. Visuals react to audio envelope and spectral bands. ".repeat(8))}
          >
            Speak (Browser TTS)
          </button>
        </div>

        {/* Remote audio */}
        <div style={{ marginTop: 18 }}>
          <label style={{ display: "block", marginBottom: 8 }}>Remote audio URL (direct .mp3/.ogg/.webm):</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ flex: 1, padding: 8, borderRadius: 6 }}
              placeholder="https://example.com/audio.mp3"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
            />
            <button className={styles.controlBtn} onClick={() => setRemoteUrl((u) => u)}>Load</button>
            <button className={styles.controlBtn} onClick={() => attachRemoteUrlViaFetch(remoteUrl, { withCredentials: false })}>
              Fetch & Attach
            </button>
          </div>

          <div style={{ marginTop: 8 }}>
            <audio ref={audioRef} controls style={{ width: "100%" }} />
            <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
              If audio requires auth/CORS, prefer a server proxy or use Fetch & Attach if allowed by the origin.
            </div>
          </div>
        </div>

        {/* Slider */}
        <div className={styles.speedControl}>
          <span className={styles.speedLabel}>Frequency Range</span>
          <input
            type="range"
            min="0"
            max="10"
            step="1"
            value={breathRange}
            onChange={(e) => setBreathRange(parseInt(e.target.value, 10))}
            className={styles.speedSlider}
          />
          <span className={styles.speedValue}>{breathRange}</span>
        </div>

        {/* Debug overlay */}
        <div
          style={{
            position: "fixed",
            right: 12,
            top: 12,
            background: "rgba(0,0,0,0.65)",
            color: "#fff",
            padding: "8px 10px",
            borderRadius: 8,
            fontSize: 12,
            lineHeight: "1.4",
            zIndex: 9999,
            minWidth: 160,
          }}
        >
          <div style={{ fontWeight: "600", marginBottom: 6 }}>Debug</div>
          <div>combined: <strong>{debugValues.combined}</strong></div>
          <div>pitchNorm: <strong>{debugValues.pitchNorm}</strong></div>
          <div>biased: <strong>{debugValues.biased}</strong></div>
          <div>pitchAct: <strong>{debugValues.pitchActivation}</strong></div>
          <div>final: <strong>{debugValues.final}</strong></div>
        </div>

        {/* Info badge */}
        <div className={`${styles.infoBadge} ${aiState === "speaking" ? styles.infoBadgeSpeaking : ""}`}>
          <span className={`${styles.infoDot} ${aiState === "speaking" ? styles.infoDotSpeaking : ""}`} />
          <span className={styles.infoText}>
            {aiState === "listening"
              ? `Core animation · range ${breathRange}/10`
              : `Core + Dots · range ${breathRange}/10 · ${currentSpeedRef.current.toFixed(2)}x`}
          </span>
        </div>
      </main>
    </>
  );
}

/* =========================
   Helper: fetch remote audio (outside component)
   ========================= */
async function attachRemoteUrlViaFetch(url, { withCredentials = false } = {}) {
  try {
    const resp = await fetch(url, { method: "GET", credentials: withCredentials ? "include" : "omit" });
    if (!resp.ok) throw new Error("Fetch failed: " + resp.status);
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  } catch (err) {
    console.error("attachRemoteUrlViaFetch failed:", err);
    return url;
  }
}