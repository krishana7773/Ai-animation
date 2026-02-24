import { useRef, useState, useEffect, useMemo } from "react";
import Lottie from "lottie-react";
import Head from "next/head";
import animationData from "../public/animation.json";
import styles from "../styles/Home.module.css";

export default function Home() {
  const coreLottieRef = useRef(null);
  const dotsLottieRef = useRef(null);
  const [aiState, setAiState] = useState("listening"); // "listening" | "speaking"
  const [breathRange, setBreathRange] = useState(0); // 0–10

  // Split the Lottie JSON into core (always visible) and dots (speaking only)
  const coreAnimationData = useMemo(
    () => ({
      ...animationData,
      layers: animationData.layers.filter((l) => l.nm !== "audio dots"),
    }),
    [],
  );

  const dotsAnimationData = useMemo(
    () => ({
      ...animationData,
      layers: animationData.layers.filter((l) => l.nm === "audio dots"),
    }),
    [],
  );

  // Derived values from range 0–10
  const normalized = breathRange / 10; // 0 → 0, 10 → 1
  const breathScale = 1 + normalized * 0.5; // 1.0 → 1.5
  const dotsOpacity = normalized; // 0 → 0, 10 → 1
  const dotsScale = 0.6 + normalized * 0.4; // 0.6 → 1.0
  const lottieSpeed = 0.3 + normalized * 1.7; // 0.3x → 2.0x

  // Update dots Lottie speed whenever range changes
  useEffect(() => {
    if (dotsLottieRef.current) {
      dotsLottieRef.current.setSpeed(lottieSpeed);
    }
  }, [lottieSpeed]);

  const handleToggleState = (state) => {
    setAiState(state);
    if (state === "speaking") {
      dotsLottieRef.current?.play();
    }
  };

  return (
    <>
      <Head>
        <title>AI Animation Player</title>
        <meta
          name="description"
          content="AI state-based Lottie animation — Listening & Speaking modes"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main className={styles.container}>
        {/* Header */}
        <header className={styles.header}>
          <h1 className={styles.title}>AI Animation</h1>
          <p className={styles.subtitle}>
            {aiState === "listening" ? "Listening..." : "Speaking..."}
          </p>
        </header>

        {/* Animation Orb */}
        <div className={styles.orbContainer}>
          {/* Breathing Circle — always visible, scale driven by range */}
          <div
            className={styles.breathCircle}
            style={{
              "--breath-scale": breathScale,
              "--breath-duration": aiState === "speaking" ? "1.5s" : "3s",
            }}
          />

          {/* Core Animation (center bubbles + shapes) — ALWAYS visible */}
          <div className={styles.lottieLayer}>
            <Lottie
              lottieRef={coreLottieRef}
              animationData={coreAnimationData}
              loop={true}
              autoplay={true}
              style={{ width: "100%", height: "100%" }}
            />
          </div>

          {/* Outer Dots — ONLY visible when Speaking, opacity/scale driven by range */}
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
              loop={true}
              autoplay={true}
              style={{ width: "100%", height: "100%" }}
            />
          </div>
        </div>

        {/* State Toggle */}
        <div className={styles.controls}>
          <button
            className={`${styles.controlBtn} ${
              aiState === "listening" ? styles.controlBtnListening : ""
            }`}
            onClick={() => handleToggleState("listening")}
          >
            <span className={styles.controlIcon}>🎤</span>
            Listening
          </button>

          <button
            className={`${styles.controlBtn} ${
              aiState === "speaking" ? styles.controlBtnSpeaking : ""
            }`}
            onClick={() => handleToggleState("speaking")}
          >
            <span className={styles.controlIcon}>🔊</span>
            Speaking
          </button>
        </div>

        {/* Breath Range Slider (0–10) */}
        <div className={styles.speedControl}>
          <span className={styles.speedLabel}>Frequency Range</span>
          <input
            type="range"
            min="0"
            max="10"
            step="1"
            value={breathRange}
            onChange={(e) => setBreathRange(parseInt(e.target.value))}
            className={styles.speedSlider}
          />
          <span className={styles.speedValue}>{breathRange}</span>
        </div>

        {/* State Info Badge */}
        <div
          className={`${styles.infoBadge} ${
            aiState === "speaking" ? styles.infoBadgeSpeaking : ""
          }`}
        >
          <span
            className={`${styles.infoDot} ${
              aiState === "speaking" ? styles.infoDotSpeaking : ""
            }`}
          />
          <span className={styles.infoText}>
            {aiState === "listening"
              ? `Core animation · range ${breathRange}/10`
              : `Core + Dots · range ${breathRange}/10 · ${lottieSpeed.toFixed(
                  1,
                )}x speed`}
          </span>
        </div>
      </main>
    </>
  );
}
