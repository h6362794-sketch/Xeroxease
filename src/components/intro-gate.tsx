"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Button } from "./ui";
import { LogoMark } from "./logo";

// In-memory fallback when sessionStorage is unavailable (also survives route remounts).
let introDismissed = false;

/**
 * Opening experience: plays the user-provided XeroxEase intro animation.
 *
 * Fit: the 16:9 (1280x720) video uses `object-contain` inside a full-viewport,
 * overflow-hidden stage so the complete composition stays visible on phones,
 * tablets and desktops in portrait and landscape — filling 16:9 desktop screens
 * edge-to-edge and spanning the full width on portrait mobile screens without
 * side-cropping, stretching or horizontal overflow.
 * Safe-area insets keep the Skip button and branding clear of notches/home bars.
 *
 * Graceful fallbacks: a poster image while loading, an explicit brand panel if
 * playback/network fails, `playsInline` + `muted` for mobile autoplay policies,
 * and automatic skipping for `prefers-reduced-motion` users.
 */
export function IntroGate({ children }: { children: React.ReactNode }) {
  const [showIntro, setShowIntro] = useState(false);
  const [introPresent, setIntroPresent] = useState(false);
  const reducedMotion = useReducedMotion();
  const [ready, setReady] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const previousOverflow = useRef("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    previousOverflow.current = document.body.style.overflow;
    let seen = introDismissed;
    try {
      seen = seen || sessionStorage.getItem("xe_intro_seen") === "1";
    } catch {
      // The module-level flag still remembers dismissal for this page lifetime.
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced && !seen) {
      setShowIntro(true);
      setIntroPresent(true);
      document.body.style.overflow = "hidden";
    }
    setReady(true);
    return () => {
      document.body.style.overflow = previousOverflow.current;
    };
  }, []);

  const finish = useCallback(() => {
    introDismissed = true;
    try {
      sessionStorage.setItem("xe_intro_seen", "1");
    } catch {
      // ignore
    }
    videoRef.current?.pause();
    setShowIntro(false);
  }, []);

  useEffect(() => {
    if (!introPresent) return;
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    controls().at(-1)?.focus();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotionChange = () => { if (reduced.matches) finish(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      if (e.key === "Tab") {
        const buttons = controls();
        const first = buttons[0];
        const last = buttons.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    reduced.addEventListener("change", onMotionChange);
    return () => {
      document.removeEventListener("keydown", onKey);
      reduced.removeEventListener("change", onMotionChange);
      document.body.style.overflow = previousOverflow.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [introPresent, finish]);

  if (!ready) return null;

  return (
    <>
      <AnimatePresence onExitComplete={() => setIntroPresent(false)}>
        {showIntro && (
          <motion.div
            ref={dialogRef}
            className="intro-overlay fixed inset-0 z-[200] overflow-hidden bg-black flex flex-col cursor-pointer"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.5, ease: [0.32, 0.72, 0, 1] }}
            onClick={finish}
            role="dialog"
            aria-modal="true"
            aria-label="XeroxEase introduction. Press Escape or use Skip Intro to continue."
          >
            <div className="intro-stage">
              {!playbackFailed ? (
                <video
                  ref={videoRef}
                  // `object-contain` is deliberate: the 16:9 intro composition must
                  // remain fully visible without side-cropping on narrow screens while
                  // filling the full viewport stage cleanly on desktop and landscape.
                  className="intro-frame relative z-0 object-contain bg-black"
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
            </div>

            <div className="absolute right-[max(1rem,env(safe-area-inset-right))] top-[max(1rem,env(safe-area-inset-top))] z-10 sm:right-[max(1.5rem,env(safe-area-inset-right))]">
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
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-1 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 text-center"
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
      <div inert={introPresent || undefined}>{children}</div>
    </>
  );
}
