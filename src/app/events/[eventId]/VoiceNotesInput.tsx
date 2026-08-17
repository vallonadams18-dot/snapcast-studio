"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// Minimal shape of the Web Speech API we use. It isn't in TypeScript's DOM
// lib because it's still vendor-prefixed in most browsers.
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string } };
  };
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Dictation for the blog-post notes. Speech runs entirely in the browser's
// own recognizer — no audio is uploaded and nothing is stored; the only
// thing that leaves the page is the text the client can see and edit.
//
// Support is uneven (Chrome/Edge/Safari yes, Firefox no), so the button only
// appears where it actually works — typing is always available.
export function VoiceNotesInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  // Whether the browser has a speech recognizer is external, non-reactive
  // state. useSyncExternalStore reads it correctly on both sides of
  // hydration — the server snapshot is false, so SSR renders the typing
  // hint and the client swaps in the button without a mismatch warning.
  const supported = useSyncExternalStore(
    () => () => {},
    () => getRecognitionCtor() !== null,
    () => false,
  );
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Kept in a ref so the recognition callbacks always append to the latest
  // text rather than whatever `value` was when the listener was attached.
  const baseTextRef = useRef(value);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  function stop() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
    setInterim("");
  }

  function start() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    setError(null);
    baseTextRef.current = value ? `${value.trimEnd()} ` : "";

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onresult = (event) => {
      let finalText = "";
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else pending += result[0].transcript;
      }
      if (finalText) {
        baseTextRef.current = `${baseTextRef.current}${finalText} `;
        onChange(baseTextRef.current);
      }
      setInterim(pending);
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("Microphone access was blocked. Allow it in your browser settings to dictate.");
      } else if (event.error !== "aborted" && event.error !== "no-speech") {
        setError("Dictation stopped unexpectedly. You can keep typing instead.");
      }
      stop();
    };

    recognition.onend = () => {
      setListening(false);
      setInterim("");
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setError("Couldn't start dictation. You can keep typing instead.");
      stop();
    }
  }

  if (!supported) {
    return (
      <p className="mt-1 text-[10px] text-neutral-500">
        Tip: dictation is available in Chrome, Edge, and Safari if you&apos;d rather speak than type.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => (listening ? stop() : start())}
        disabled={disabled}
        className={`tap-scale flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs font-medium disabled:opacity-50 ${
          listening
            ? "bg-error/15 text-error"
            : "border border-border bg-background text-foreground"
        }`}
      >
        <span className={listening ? "animate-pulse" : ""}>{listening ? "●" : "🎤"}</span>
        {listening ? "Listening — tap to stop" : "Speak instead of typing"}
      </button>

      {listening && (
        <p className="mt-1 text-[11px] italic text-neutral-500">
          {interim || "Go ahead — describe the event…"}
        </p>
      )}
      {listening && (
        <p className="mt-1 text-[10px] text-neutral-500">
          Speech is transcribed by your browser. No audio is uploaded or saved.
        </p>
      )}
      {error && <p className="mt-1 text-[11px] text-error">{error}</p>}
    </div>
  );
}
