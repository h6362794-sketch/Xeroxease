"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "./ui";
import { LogoMark } from "./logo";

/**
 * Opening experience: plays the user-provided XeroxEase intro animation.
 *
 * Fit: the video is `object-contain` inside a full-viewport, overflow-hidden
 * layer, so the whole composition stays visible on phones, tablets and desktops
 * in portrait and landscape — never cropped, stretched or spilling sideways.
 * Safe-area insets keep the Skip button and branding clear of notches/home bars.
 *
 * Graceful fallbacks: a poster image while loading, an explicit brand panel if
 * playback/network fails, `playsInline` + `muted` for mobile autoplay policies,
 * and automatic skipping for `prefers-reduced-motion` users.
 */
export function IntroGate({ children }: { children: React.ReactNode }) {
  const [showIntro, setShowIntro] = useState(false);
  const [ready, setReady] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem("xe_intro_seen") === "1";
    } catch {
      // Storage can be blocked; showing the intro once is harmless.
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced && !seen) {
      setShowIntro(true);
      document.body.style.overflow = "hidden";
    }
    setReady(true);
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const finish = useCallback(() => {
    try {
      sessionStorage.setItem("xe_intro_seen", "1");
    } catch {
      // ignore
    }
    document.body.style.overflow = "";
    setShowIntro(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    if (showIntro) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showIntro, finish]);

  if (!ready) return null;

  return (
    <>
      <AnimatePresence>
        {showIntro && (
          <motion.div
            className="fixed inset-0 z-[200] overflow-hidden bg-black flex flex-col cursor-pointer"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.02 }}
            transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
            onClick={finish}
            role="dialog"
            aria-modal="true"
            aria-label="XeroxEase introduction. Press Escape or use Skip Intro to continue."
          >
            {!playbackFailed ? (
              <video
                ref={videoRef}
                // `object-contain` is deliberate: the intro composition must remain
                // fully visible. `object-cover` used to crop it on narrow screens.
                // The video owns the flexible row above the branding strip, so the
                // overlay can never sit on top of the artwork.
                className="relative z-0 min-h-0 w-full flex-1 object-contain bg-black"
                src="/brand/xeroxease-intro.mp4"
                poster="/brand/xeroxease-logo.jpeg"
                autoPlay
                muted
                playsInline
                preload="metadata"
                controls={false}
                aria-label="XeroxEase animated introduction"
                onEnded={finish}
                onError={() => setPlaybackFailed(true)}
              />
            ) : (
              <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
                <LogoMark size={72} className="ring-2 ring-white/20" />
                <p className="text-2xl font-extrabold text-white">XeroxEase</p>
                <p className="text-sm text-zinc-400 max-w-xs">
                  The intro animation could not play on this device or connection.
                </p>
                <Button
                  variant="brand"
                  onClick={(e) => {
                    e.stopPropagation();
                    finish();
                  }}
                >
                  Enter site
                </Button>
              </div>
            )}

            <div className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 sm:right-6">
              <Button
                variant="ghost"
                size="md"
                aria-label="Skip introduction"
                onClick={(e) => {
                  e.stopPropagation();
                  finish();
                }}
              >
                Skip Intro
              </Button>
            </div>

            <motion.div
              className="relative z-10 flex shrink-0 flex-col items-center gap-1 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 text-center"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.8, duration: 0.5 }}
            >
              <LogoMark size={36} className="ring-2 ring-white/20" />
              <p className="text-[10px] uppercase tracking-[0.25em] text-white/70 sm:text-xs">
                Efficient Document Solutions
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {children}
    </>
  );
}
