import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import type { PersistedAppConfig } from "../Settings";
import type {
    PreparedSpeech,
    PreviewSentence,
    RenderedPage,
    SynthesizedSpeech,
} from "./types";

const MAX_PREFETCH_AHEAD = 7;
const REMOTE_TTS_RETRY_BACKOFF_MS = 350;

type UseSpeechOptions = {
    appConfig: PersistedAppConfig;
    previewPages: RenderedPage[];
    setAppError: React.Dispatch<React.SetStateAction<string | null>>;
};

type UseSpeechResult = {
    activeSentenceKey: string;
    isReadingAll: boolean;
    speakSentence: (pageIndex: number, sentence: PreviewSentence) => void;
    readAllSentences: () => void;
    stopReading: () => void;
    clearSpeechCache: () => void;
};

type CachedSpeechEntry = {
    signature: string;
    prepared: PreparedSpeech;
};

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        void promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export function useSpeech({
    appConfig,
    previewPages,
    setAppError,
}: UseSpeechOptions): UseSpeechResult {
    const [activeSentenceKey, setActiveSentenceKey] = useState("");
    const [isReadingAll, setIsReadingAll] = useState(false);
    const speechTokenRef = useRef(0);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const playbackResolveRef = useRef<(() => void) | null>(null);
    const speechCacheRef = useRef<Map<string, Promise<CachedSpeechEntry>>>(
        new Map(),
    );
    const speechCacheLimit = Math.max(1, appConfig.speechCacheLimit);
    const isLocalTts = appConfig.ttsMode.trim().toLowerCase() === "local";
    const remoteTtsTimeoutMs = Math.max(500, appConfig.ttsRequestTimeoutMs);
    const remoteTtsMaxRetries = Math.max(0, appConfig.ttsMaxRetries);

    const buildSpeechCacheSignature = (): string => {
        if (isLocalTts) {
            return `mode:local;llm:${appConfig.preprocessTtsWithLlm ? "on" : "off"}`;
        }

        return [
            "mode:remote",
            `provider:${appConfig.provider.trim().toLowerCase()}`,
            `base:${appConfig.baseUrl.trim()}`,
            `model:${appConfig.ttsModel.trim()}`,
            `voice:${appConfig.ttsVoice.trim()}`,
            `llm:${appConfig.preprocessTtsWithLlm ? "on" : "off"}`,
            `timeout:${remoteTtsTimeoutMs}`,
            `maxRetries:${remoteTtsMaxRetries}`,
        ].join(";");
    };

    const stopPlayback = () => {
        if (typeof window !== "undefined" && window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }
        if (playbackResolveRef.current) {
            const resolve = playbackResolveRef.current;
            playbackResolveRef.current = null;
            resolve();
        }
    };

    const stopReading = () => {
        speechTokenRef.current += 1;
        stopPlayback();
        setIsReadingAll(false);
        setActiveSentenceKey("");
    };

    const clearSpeechCache = () => {
        speechCacheRef.current.clear();
    };

    const prepareSpeech = async (rawText: string): Promise<PreparedSpeech> => {
        let text = rawText;
        try {
            const refined = await invoke<string>("preprocess_tts_text", {
                text: rawText,
            });
            const cleaned = refined?.trim();
            if (cleaned && cleaned.length > 0) {
                text = cleaned;
            }
        } catch (error) {
            setAppError(
                (previous) =>
                    previous ??
                    `TTS preprocessing failed, reading raw text: ${String(error)}`,
            );
        }

        if (isLocalTts) {
            return { text, audio: null };
        }

        let attempts = 0;
        let lastError: unknown = null;

        while (attempts <= remoteTtsMaxRetries) {
            attempts += 1;

            try {
                const audio = await withTimeout(
                    invoke<SynthesizedSpeech | null>(
                        "synthesize_speech",
                        { text },
                    ),
                    remoteTtsTimeoutMs,
                );
                return { text, audio };
            } catch (error) {
                lastError = error;

                if (attempts > remoteTtsMaxRetries) {
                    break;
                }

                await delay(REMOTE_TTS_RETRY_BACKOFF_MS);
            }
        }

        setAppError(
            (previous) =>
                previous ??
                `Provider TTS fallback to local after ${attempts} attempt(s): ${String(lastError)}`,
        );

        // Fallback to local voice when timeout/retry budget is exhausted.
        return { text, audio: null };
    };

    const getPreparedSpeech = async (rawText: string): Promise<PreparedSpeech> => {
        const activeSignature = buildSpeechCacheSignature();
        const cache = speechCacheRef.current;
        const existing = cache.get(rawText);
        if (existing) {
            const cached = await existing;
            if (cached.signature === activeSignature) {
                return cached.prepared;
            }

            // Settings changed (for example local -> remote), so regenerate.
            cache.delete(rawText);
        }

        const entry = prepareSpeech(rawText).then((prepared) => ({
            signature: activeSignature,
            prepared,
        }));
        cache.set(rawText, entry);
        while (cache.size > speechCacheLimit) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            cache.delete(oldest);
        }

        return (await entry).prepared;
    };

    const playPrepared = (
        prepared: PreparedSpeech,
        token: number,
    ): Promise<void> =>
        new Promise<void>((resolve) => {
            const finish = () => {
                if (playbackResolveRef.current === finish) {
                    playbackResolveRef.current = null;
                }
                resolve();
            };
            playbackResolveRef.current = finish;

            if (
                speechTokenRef.current !== token ||
                typeof window === "undefined"
            ) {
                finish();
                return;
            }

            const playWithBrowserVoice = () => {
                if (
                    speechTokenRef.current !== token ||
                    !window.speechSynthesis
                ) {
                    finish();
                    return;
                }
                const utterance = new SpeechSynthesisUtterance(prepared.text);
                utterance.onend = finish;
                utterance.onerror = finish;
                window.speechSynthesis.speak(utterance);
            };

            if (prepared.audio?.audioBase64) {
                const element = new Audio(
                    `data:${prepared.audio.mimeType};base64,${prepared.audio.audioBase64}`,
                );
                audioRef.current = element;
                element.onended = finish;
                element.onerror = () => {
                    if (audioRef.current === element) {
                        audioRef.current = null;
                    }
                    playWithBrowserVoice();
                };
                void element.play().catch(() => playWithBrowserVoice());
                return;
            }

            playWithBrowserVoice();
        });

    const prepareAndPlay = async (
        rawText: string,
        token: number,
    ): Promise<void> => {
        if (speechTokenRef.current !== token) {
            return;
        }

        const prepared = await getPreparedSpeech(rawText);
        if (speechTokenRef.current !== token) {
            return;
        }

        await playPrepared(prepared, token);
    };

    const speakSentence = (pageIndex: number, sentence: PreviewSentence) => {
        if (typeof window === "undefined") {
            return;
        }

        const key = `${pageIndex}:${sentence.id}`;

        if (!isReadingAll && activeSentenceKey === key) {
            stopReading();
            return;
        }

        stopReading();
        const token = (speechTokenRef.current += 1);
        setActiveSentenceKey(key);

        void prepareAndPlay(sentence.text, token).then(() => {
            if (speechTokenRef.current === token) {
                setActiveSentenceKey((previous) =>
                    previous === key ? "" : previous,
                );
            }
        });
    };

    const readAllSentences = () => {
        if (typeof window === "undefined") {
            return;
        }

        if (isReadingAll) {
            stopReading();
            return;
        }

        const queue: Array<{ key: string; text: string }> = [];
        for (const page of previewPages) {
            for (const sentence of page.sentences ?? []) {
                queue.push({
                    key: `${page.index}:${sentence.id}`,
                    text: sentence.text,
                });
            }
        }

        if (!queue.length) {
            return;
        }

        stopReading();
        const token = (speechTokenRef.current += 1);
        setIsReadingAll(true);

        void (async () => {
            let playIndex = 0;
            let prefetchIndex = 0;
            let prefetching = false;

            const pumpPrefetch = () => {
                if (
                    speechTokenRef.current !== token ||
                    prefetching ||
                    prefetchIndex >= queue.length
                ) {
                    return;
                }
                if (prefetchIndex - playIndex >= MAX_PREFETCH_AHEAD) {
                    return;
                }

                prefetching = true;
                const requestIndex = prefetchIndex;
                prefetchIndex += 1;
                void getPreparedSpeech(queue[requestIndex].text).finally(() => {
                    prefetching = false;
                    pumpPrefetch();
                });
            };

            pumpPrefetch();

            for (playIndex = 0; playIndex < queue.length; playIndex += 1) {
                if (speechTokenRef.current !== token) {
                    break;
                }

                pumpPrefetch();

                const item = queue[playIndex];
                setActiveSentenceKey(item.key);
                const prepared = await getPreparedSpeech(item.text);
                if (speechTokenRef.current !== token) {
                    break;
                }
                await playPrepared(prepared, token);
            }

            if (speechTokenRef.current === token) {
                setIsReadingAll(false);
                setActiveSentenceKey("");
            }
        })();
    };

    return {
        activeSentenceKey,
        isReadingAll,
        speakSentence,
        readAllSentences,
        stopReading,
        clearSpeechCache,
    };
}
