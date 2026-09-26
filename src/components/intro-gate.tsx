"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "./ui";
import { LogoMark } from "./logo";

/**
 * Opening experience: plays the user-provided XeroxEase intro animation.
 * - Skippable (Skip Intro button, tap anywhere, Esc)
 * - sessionStorage preference so returning users skip it
 * - prefers-reduced-motion users skip automatically
 */
export function IntroGate({ children }: { children: React.ReactNode }) {
  const [showIntro, setShowIntro] = useState(false);
  const [ready, setReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const seen = sessionStorage.getItem("xe_intro_seen") === "1";
    if (!reduced && !seen) {
      setShowIntro(true);
      document.body.style.overflow = "hidden";
    }
    setReady(true);
  }, []);

  const finish = () => {
    sessionStorage.setItem("xe_intro_seen", "1");
    document.body.style.overflow = "";
    setShowIntro(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    if (showIntro) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIntro]);

  if (!ready) return null;

  return (
    <>
      <AnimatePresence>
        {showIntro && (
          <motion.div
            className="fixed inset-0 z-[200] bg-black flex items-center justify-center cursor-pointer"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.04 }}
            transition={{ duration: 0.6, ease: [0.32, 0.72, 0, 1] }}
            onClick={finish}
            role="dialog"
            aria-label="XeroxEase introduction"
          >
            <video
              ref={videoRef}
              className="absolute inset-0 h-full w-full object-cover"
              src="/brand/xeroxease-intro.mp4"
              autoPlay
              muted
              playsInline
              onEnded={finish}
              onError={finish}
            />
            <div className="absolute top-5 right-5 z-10">
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  finish();
                }}
              >
                Skip Intro
              </Button>
            </div>
            <motion.div
              className="absolute bottom-10 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-3"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.8, duration: 0.5 }}
            >
              <LogoMark size={56} className="ring-2 ring-white/20" />
              <p className="text-xs uppercase tracking-[0.3em] text-white/70">Efficient Document Solutions</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {children}
    </>
  );
}
