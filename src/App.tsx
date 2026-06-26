import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { startTransition, useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, Util, getDocument } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/display_utils";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./App.css";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type SessionItem = {
	id: string;
	title: string;
	updatedAt: string;
	path: string;
};

type SessionFile = {
	id: string;
	name: string;
	status: "draft" | "processed" | "raw";
};

type FolderSession = {
	id: string;
	title: string;
	updatedAt: string;
	path: string;
	files: SessionFile[];
};

type PersistedAppState = {
	sessionCollapsed: boolean;
	filesCollapsed: boolean;
	activeSession: string;
	activeFile: string;
	sessions: SessionItem[];
	filesBySession: Record<string, SessionFile[]>;
};

type PersistedAppConfig = {
	provider: string;
	apiKey: string;
	baseUrl: string;
	model: string;
};

type ChatMessage = {
	id: string;
	role: "assistant" | "user";
	text: string;
};

type ChatRequest = {
	userMessage: string;
	sessionTitle?: string;
	sessionPath?: string;
	activeFileName?: string;
	activeFileStatus?: string;
	recentMessages: ChatMessage[];
};

type ChatResponse = {
	provider: string;
	model: string;
	text: string;
};

type SentenceRect = {
	left: number;
	top: number;
	width: number;
	height: number;
};

type PreviewSentence = {
	id: string;
	text: string;
	rects: SentenceRect[];
};

type SynthesizedSpeech = {
	mimeType: string;
	audioBase64: string;
};

type PreparedSpeech = {
	text: string;
	audio: SynthesizedSpeech | null;
};

type RenderedPage = {
	index: number;
	title: string;
	label: string;
	imageDataUrl: string;
	width: number;
	height: number;
	sentences?: PreviewSentence[];
};

type RenderedDocument = {
	sourcePath: string;
	fileName: string;
	format: string;
	pdfDataUrl: string | null;
	pages: RenderedPage[];
};

const SUPPORTED_EXTENSIONS = new Set(["md", "pdf", "docx", "pptx"]);

function getFileExtension(fileName: string): string {
	const segments = fileName.toLowerCase().split(".");
	return segments.length > 1 ? segments[segments.length - 1] : "";
}

function isRenderableFile(fileName: string): boolean {
	return SUPPORTED_EXTENSIONS.has(getFileExtension(fileName));
}

const SENTENCE_ABBREVIATIONS = new Set([
	"mr",
	"mrs",
	"ms",
	"dr",
	"prof",
	"sr",
	"jr",
	"st",
	"vs",
	"etc",
	"fig",
	"no",
	"vol",
	"pp",
	"al",
	"inc",
	"ltd",
	"co",
	"dept",
	"univ",
	"approx",
	"cf",
	"jan",
	"feb",
	"mar",
	"apr",
	"jun",
	"jul",
	"aug",
	"sep",
	"sept",
	"oct",
	"nov",
	"dec",
	"e.g",
	"i.e",
	"u.s",
	"a.m",
	"p.m",
	"ph.d",
]);

const SENTENCE_TERMINATORS = new Set([".", "!", "?", "\u3002", "\uff01", "\uff1f"]);
const CLOSING_PUNCTUATION = "\"')]}\u201d\u2019\u300d\u300f";
const SENTENCE_OPENERS = /[A-Z0-9"'(\[\u201c\u2018\u300c\u300e\u00bf\u00a1]/;

function computeSentenceRanges(text: string, forcedBreaks: number[]): Array<{ start: number; end: number }> {
	const length = text.length;
	const cuts = new Set<number>([0, length]);

	for (const offset of forcedBreaks) {
		if (offset > 0 && offset < length) {
			cuts.add(offset);
		}
	}

	let index = 0;
	while (index < length) {
		const char = text[index];
		if (!SENTENCE_TERMINATORS.has(char)) {
			index += 1;
			continue;
		}

		let boundary = index + 1;
		while (boundary < length && (SENTENCE_TERMINATORS.has(text[boundary]) || CLOSING_PUNCTUATION.includes(text[boundary]))) {
			boundary += 1;
		}

		let lookahead = boundary;
		while (lookahead < length && /\s/.test(text[lookahead])) {
			lookahead += 1;
		}
		const nextChar = lookahead < length ? text[lookahead] : "";

		let shouldSplit = nextChar === "" || SENTENCE_OPENERS.test(nextChar);

		if (shouldSplit && char === ".") {
			const prevChar = index > 0 ? text[index - 1] : "";
			if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
				shouldSplit = false;
			} else {
				let wordStart = index;
				while (wordStart > 0 && /[A-Za-z.]/.test(text[wordStart - 1])) {
					wordStart -= 1;
				}
				const rawWord = text.slice(wordStart, index);
				const word = rawWord.toLowerCase();
				const isInitial = rawWord.length === 1 && /[A-Za-z]/.test(rawWord);
				if (SENTENCE_ABBREVIATIONS.has(word) || isInitial) {
					shouldSplit = false;
				}
			}
		}

		if (shouldSplit) {
			cuts.add(boundary);
			index = boundary;
		} else {
			index = boundary;
		}
	}

	const sorted = Array.from(cuts).sort((a, b) => a - b);
	const ranges: Array<{ start: number; end: number }> = [];
	for (let cut = 0; cut < sorted.length - 1; cut += 1) {
		const start = sorted[cut];
		const end = sorted[cut + 1];
		if (text.slice(start, end).trim().length > 0) {
			ranges.push({ start, end });
		}
	}

	return ranges;
}

function buildPageSentences(textContent: TextContent, viewport: PageViewport): PreviewSentence[] {
	let fullText = "";
	const pieces: Array<{ start: number; end: number; rect: SentenceRect }> = [];
	const forcedBreaks: number[] = [];
	let previousTop: number | null = null;
	let previousBottom: number | null = null;

	for (const item of textContent.items) {
		if (!("str" in item) || item.str.length === 0) {
			if ("hasEOL" in item && item.hasEOL && fullText.length > 0 && !/\s$/.test(fullText)) {
				fullText += " ";
			}
			continue;
		}

		const transform = Util.transform(viewport.transform, item.transform);
		const fontHeight = Math.hypot(transform[2], transform[3]);
		const widthPx = item.width * viewport.scale;
		const left = transform[4];
		const top = transform[5] - fontHeight;

		const rect: SentenceRect = {
			left: (left / viewport.width) * 100,
			top: (top / viewport.height) * 100,
			width: (widthPx / viewport.width) * 100,
			height: (fontHeight / viewport.height) * 100,
		};

		const startsNewLine = previousTop !== null && top - previousTop > fontHeight * 0.5;
		const paragraphGap = startsNewLine && previousBottom !== null && top - previousBottom > fontHeight * 0.7;

		if (fullText.length > 0 && !/\s$/.test(fullText) && !/^\s/.test(item.str)) {
			fullText += " ";
		}

		if (paragraphGap) {
			forcedBreaks.push(fullText.length);
		}

		const start = fullText.length;
		fullText += item.str;
		pieces.push({ start, end: fullText.length, rect });

		previousTop = top;
		previousBottom = top + fontHeight;

		if (item.hasEOL && !/\s$/.test(fullText)) {
			fullText += " ";
		}
	}

	const ranges = computeSentenceRanges(fullText, forcedBreaks);
	const sentences: PreviewSentence[] = [];

	ranges.forEach((range, rangeIndex) => {
		const text = fullText.slice(range.start, range.end).replace(/\s+/g, " ").trim();
		if (!text) {
			return;
		}

		const rects = pieces
			.filter((piece) => piece.start < range.end && piece.end > range.start)
			.map((piece) => piece.rect);
		if (!rects.length) {
			return;
		}

		sentences.push({ id: `s-${rangeIndex}`, text, rects });
	});

	return sentences;
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
	const base64 = dataUrl.split(",", 2)[1] ?? "";
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function providerRequiresApiKey(provider: string): boolean {
	const normalized = provider.trim().toLowerCase();
	if (!normalized) {
		return false;
	}

	return !normalized.includes("local");
}

function collectMissingConfigFields(config: PersistedAppConfig): Array<keyof PersistedAppConfig> {
	const missingFields: Array<keyof PersistedAppConfig> = [];

	if (!config.provider.trim()) {
		missingFields.push("provider");
	}

	if (providerRequiresApiKey(config.provider) && !config.apiKey.trim()) {
		missingFields.push("apiKey");
	}

	if (config.provider.trim().toLowerCase() === "openai-compatible" && !config.baseUrl.trim()) {
		missingFields.push("baseUrl");
	}

	if (!config.model.trim()) {
		missingFields.push("model");
	}

	return missingFields;
}

async function ensureRequiredConfigAtStartup(): Promise<void> {
	const loadedConfig = await invoke<PersistedAppConfig>("load_app_config");
	const config = { ...loadedConfig };
	const missingFields = collectMissingConfigFields(config);

	if (!missingFields.length) {
		return;
	}

	const fieldPrompts: Record<keyof PersistedAppConfig, string> = {
		provider: "Enter LLM provider (for example: openai-compatible, local):",
		apiKey: "Enter API key for the configured provider:",
		baseUrl: "Enter base URL for openai-compatible provider:",
		model: "Enter default model name:",
	};

	for (const field of missingFields) {
		const value = window.prompt(fieldPrompts[field], config[field]);
		if (value === null) {
			throw new Error(`Missing required setting: ${field}`);
		}
		config[field] = value.trim();
	}

	const missingAfterPrompt = collectMissingConfigFields(config);
	if (missingAfterPrompt.length) {
		throw new Error(`Missing required settings: ${missingAfterPrompt.join(", ")}`);
	}

	await invoke("save_app_config", { config });
}

async function renderPdfToPages(previewDocument: RenderedDocument): Promise<RenderedPage[]> {
	if (!previewDocument.pdfDataUrl) {
		return previewDocument.pages;
	}

	const pdf = await getDocument({ data: dataUrlToUint8Array(previewDocument.pdfDataUrl) }).promise;
	const pages: RenderedPage[] = [];

	for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
		const page = await pdf.getPage(pageNumber);
		const viewport = page.getViewport({ scale: 1.6 });
		const canvas = window.document.createElement("canvas");
		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error("Failed to create PDF rendering canvas.");
		}

		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);

		await page.render({ canvas, canvasContext: context, viewport }).promise;

		const textContent = await page.getTextContent();
		const sentences = buildPageSentences(textContent, viewport);

		pages.push({
			index: pageNumber - 1,
			title: previewDocument.fileName,
			label: `${previewDocument.format.toUpperCase()} page ${pageNumber}`,
			imageDataUrl: canvas.toDataURL("image/png"),
			width: canvas.width,
			height: canvas.height,
			sentences,
		});
	}

	return pages;
}

function App() {
	const [sessionCollapsed, setSessionCollapsed] = useState(false);
	const [filesCollapsed, setFilesCollapsed] = useState(false);
	const [activeSession, setActiveSession] = useState("");
	const [activeFile, setActiveFile] = useState("");
	const [sessions, setSessions] = useState<SessionItem[]>([]);
	const [filesBySession, setFilesBySession] = useState<Record<string, SessionFile[]>>({});
	const [appStateReady, setAppStateReady] = useState(false);
	const [loadingFolder, setLoadingFolder] = useState(false);
	const [isLoadingPreview, setIsLoadingPreview] = useState(false);
	const [chatPending, setChatPending] = useState(false);
	const [chatInput, setChatInput] = useState("");
	const [previewPages, setPreviewPages] = useState<RenderedPage[]>([]);
	const [renderedDocument, setRenderedDocument] = useState<RenderedDocument | null>(null);
	const [activeSentenceKey, setActiveSentenceKey] = useState("");
	const [isReadingAll, setIsReadingAll] = useState(false);
	const speechTokenRef = useRef(0);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const playbackResolveRef = useRef<(() => void) | null>(null);
	const speechCacheRef = useRef<Map<string, Promise<PreparedSpeech>>>(new Map());
	const [appError, setAppError] = useState<string | null>(null);
	const [previewError, setPreviewError] = useState("");
	const [messages, setMessages] = useState<ChatMessage[]>([
		{
			id: "m-1",
			role: "assistant",
			text: "I can now call your configured LLM. Ask with the current session and file context.",
		},
	]);

	const activeSessionDetails = sessions.find((session) => session.id === activeSession) ?? null;
	const currentFiles = filesBySession[activeSession] ?? [];
	const activeFileDetails = currentFiles.find((file) => file.id === activeFile) ?? currentFiles[0] ?? null;
	const renderableFiles = currentFiles.filter((file) => isRenderableFile(file.name));

	useEffect(() => {
		let cancelled = false;

		const loadAndValidateConfig = async () => {
			try {
				await ensureRequiredConfigAtStartup();
			} catch (error) {
				if (!cancelled) {
					setAppError(`Settings are incomplete: ${String(error)}`);
				}
			}
		};

		void loadAndValidateConfig();

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;

		const restoreAppState = async () => {
			try {
				const persistedState = await invoke<PersistedAppState | null>("load_app_state");
				if (cancelled || !persistedState) {
					return;
				}

				setSessionCollapsed(persistedState.sessionCollapsed);
				setFilesCollapsed(persistedState.filesCollapsed);
				setActiveSession(persistedState.activeSession);
				setActiveFile(persistedState.activeFile);
				setSessions(persistedState.sessions);
				setFilesBySession(persistedState.filesBySession);
			} catch (error) {
				if (!cancelled) {
					setAppError(`Failed to restore app state: ${String(error)}`);
				}
			} finally {
				if (!cancelled) {
					setAppStateReady(true);
				}
			}
		};

		void restoreAppState();

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!appStateReady) {
			return;
		}

		const persistedState: PersistedAppState = {
			sessionCollapsed,
			filesCollapsed,
			activeSession,
			activeFile,
			sessions,
			filesBySession,
		};

		void invoke("save_app_state", { state: persistedState }).catch((error) => {
			setAppError((previous) => previous ?? `Failed to save app state: ${String(error)}`);
		});
	}, [activeFile, activeSession, appStateReady, filesBySession, filesCollapsed, sessionCollapsed, sessions]);

	useEffect(() => {
		if (!currentFiles.length) {
			if (activeFile) {
				setActiveFile("");
			}
			return;
		}

		if (!currentFiles.some((file) => file.id === activeFile)) {
			setActiveFile(currentFiles[0].id);
		}
	}, [activeFile, currentFiles]);

	useEffect(() => {
		if (!activeSessionDetails || !activeFileDetails) {
			setRenderedDocument(null);
			setPreviewPages([]);
			return;
		}

		if (!isRenderableFile(activeFileDetails.name)) {
			setRenderedDocument(null);
			setPreviewPages([]);
			setPreviewError("Preview supports md, pdf, docx, and pptx files.");
			return;
		}

		let cancelled = false;

		const renderPreview = async () => {
			setIsLoadingPreview(true);
			setPreviewError("");

			try {
				const document = await invoke<RenderedDocument>("render_active_file", {
					sessionPath: activeSessionDetails.path,
					fileName: activeFileDetails.name,
				});
				const pages = document.pdfDataUrl ? await renderPdfToPages(document) : document.pages;

				if (!cancelled) {
					setRenderedDocument(document);
					setPreviewPages(pages);
				}
			} catch (error) {
				if (!cancelled) {
					setRenderedDocument(null);
					setPreviewPages([]);
					setPreviewError(error instanceof Error ? error.message : String(error));
				}
			} finally {
				if (!cancelled) {
					setIsLoadingPreview(false);
				}
			}
		};

		void renderPreview();

		return () => {
			cancelled = true;
			speechTokenRef.current += 1;
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
			speechCacheRef.current.clear();
			setIsReadingAll(false);
			setActiveSentenceKey("");
		};
	}, [activeFileDetails, activeSessionDetails]);

	const openFolderAsSession = async () => {
		setAppError(null);
		setLoadingFolder(true);
		try {
			const selected = await open({
				directory: true,
				multiple: false,
				title: "Choose a folder to open as a session",
			});

			if (!selected || Array.isArray(selected)) {
				return;
			}

			const nextSession = await invoke<FolderSession>("read_folder_session", { path: selected });
			const nextRenderableFile = nextSession.files.find((file) => isRenderableFile(file.name));

			startTransition(() => {
				setSessions((previous) => {
					const withoutDuplicate = previous.filter((item) => item.id !== nextSession.id);
					return [{ id: nextSession.id, title: nextSession.title, updatedAt: nextSession.updatedAt, path: nextSession.path }, ...withoutDuplicate];
				});
				setFilesBySession((previous) => ({ ...previous, [nextSession.id]: nextSession.files }));
				setActiveSession(nextSession.id);
				setActiveFile(nextRenderableFile?.id ?? nextSession.files[0]?.id ?? "");
				setRenderedDocument(null);
				setPreviewPages([]);
			});

			if (!nextRenderableFile && nextSession.files.length > 0) {
				setPreviewError("No renderable files found in this folder. Supported: md, pdf, docx, pptx.");
			}
		} catch (error) {
			setAppError(String(error));
		} finally {
			setLoadingFolder(false);
		}
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

	// Preprocess and synthesize a sentence ahead of time. Results are cached and
	// reused so the next sentence can be fetched while the current one is playing.
	const prepareSpeech = async (rawText: string): Promise<PreparedSpeech> => {
		let text = rawText;
		try {
			const refined = await invoke<string>("preprocess_tts_text", { text: rawText });
			const cleaned = refined?.trim();
			if (cleaned && cleaned.length > 0) {
				text = cleaned;
			}
		} catch (error) {
			setAppError((previous) => previous ?? `TTS preprocessing failed, reading raw text: ${String(error)}`);
		}

		let audio: SynthesizedSpeech | null = null;
		try {
			audio = await invoke<SynthesizedSpeech | null>("synthesize_speech", { text });
		} catch (error) {
			setAppError((previous) => previous ?? `Provider TTS failed, using built-in voice: ${String(error)}`);
		}

		return { text, audio };
	};

	const SPEECH_CACHE_LIMIT = 7;
	const MAX_PREFETCH_AHEAD = 7;

	const getPreparedSpeech = (rawText: string): Promise<PreparedSpeech> => {
		const cache = speechCacheRef.current;
		const existing = cache.get(rawText);
		if (existing) {
			return existing;
		}

		const entry = prepareSpeech(rawText);
		cache.set(rawText, entry);
		while (cache.size > SPEECH_CACHE_LIMIT) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			cache.delete(oldest);
		}
		return entry;
	};

	const playPrepared = (prepared: PreparedSpeech, token: number): Promise<void> =>
		new Promise<void>((resolve) => {
			const finish = () => {
				if (playbackResolveRef.current === finish) {
					playbackResolveRef.current = null;
				}
				resolve();
			};
			playbackResolveRef.current = finish;

			if (speechTokenRef.current !== token || typeof window === "undefined") {
				finish();
				return;
			}

			const playWithBrowserVoice = () => {
				if (speechTokenRef.current !== token || !window.speechSynthesis) {
					finish();
					return;
				}
				const utterance = new SpeechSynthesisUtterance(prepared.text);
				utterance.onend = finish;
				utterance.onerror = finish;
				window.speechSynthesis.speak(utterance);
			};

			if (prepared.audio?.audioBase64) {
				const element = new Audio(`data:${prepared.audio.mimeType};base64,${prepared.audio.audioBase64}`);
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

	const prepareAndPlay = async (rawText: string, token: number): Promise<void> => {
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
				setActiveSentenceKey((previous) => (previous === key ? "" : previous));
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
				queue.push({ key: `${page.index}:${sentence.id}`, text: sentence.text });
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

			// Serially prefetch ahead: fire the next request only once the previous
			// output is received, keeping at most MAX_PREFETCH_AHEAD audios buffered.
			const pumpPrefetch = () => {
				if (speechTokenRef.current !== token || prefetching || prefetchIndex >= queue.length) {
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

				// Playback advanced, free a slot in the prefetch window.
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

	const sendChatMessage = async () => {
		const trimmedMessage = chatInput.trim();
		if (!trimmedMessage || chatPending) {
			return;
		}

		setChatPending(true);
		setAppError(null);

		const userMessage: ChatMessage = {
			id: `u-${Date.now()}`,
			role: "user",
			text: trimmedMessage,
		};

		const pendingMessages = [...messages, userMessage];
		setMessages(pendingMessages);
		setChatInput("");

		try {
			const request: ChatRequest = {
				userMessage: trimmedMessage,
				sessionTitle: activeSessionDetails?.title,
				sessionPath: activeSessionDetails?.path,
				activeFileName: activeFileDetails?.name,
				activeFileStatus: activeFileDetails?.status,
				recentMessages: pendingMessages.slice(-8),
			};

			const response = await invoke<ChatResponse>("chat_with_context", { request });
			const assistantMessage: ChatMessage = {
				id: `a-${Date.now()}`,
				role: "assistant",
				text: response.text,
			};

			setMessages((previous) => [...previous, assistantMessage]);
		} catch (error) {
			const errorMessage: ChatMessage = {
				id: `e-${Date.now()}`,
				role: "assistant",
				text: `Failed to call LLM: ${String(error)}`,
			};

			setMessages((previous) => [...previous, errorMessage]);
			setAppError((previous) => previous ?? `Chat failed: ${String(error)}`);
		} finally {
			setChatPending(false);
		}
	};

	return (
		<main className="workspace">
			<section className={`panel panel-session ${sessionCollapsed ? "is-collapsed" : ""}`}>
				<div className="panel-header">
					{!sessionCollapsed && <h2>Sessions</h2>}
					<button
						className="icon-btn"
						type="button"
						onClick={() => setSessionCollapsed((previous) => !previous)}
						aria-label={sessionCollapsed ? "Expand sessions" : "Collapse sessions"}
						title={sessionCollapsed ? "Expand sessions" : "Collapse sessions"}
					>
						{sessionCollapsed ? "»" : "«"}
					</button>
				</div>

				<div className="panel-body scroll-y">
					{!sessionCollapsed && (
						<button className="action-btn" type="button" onClick={openFolderAsSession} disabled={loadingFolder}>
							{loadingFolder ? "Opening..." : "Open Folder"}
						</button>
					)}

					{appError && !sessionCollapsed ? <p className="error-note">{appError}</p> : null}

					{sessions.map((session) => (
						<button
							key={session.id}
							type="button"
							className={`list-item ${activeSession === session.id ? "active" : ""}`}
							onClick={() => {
								setActiveSession(session.id);
								setActiveFile((filesBySession[session.id] ?? [])[0]?.id ?? "");
							}}
						>
							{sessionCollapsed ? (
								<span className="mono-index">{session.title.slice(0, 1)}</span>
							) : (
								<>
									<span className="item-title">{session.title}</span>
									<span className="item-meta">{session.updatedAt}</span>
									<span className="item-meta path">{session.path}</span>
								</>
							)}
						</button>
					))}

					{!sessions.length && !sessionCollapsed ? <p className="empty-note">No sessions yet. Open a folder to begin.</p> : null}
				</div>
			</section>

			<section className={`panel panel-files ${filesCollapsed ? "is-collapsed" : ""}`}>
				<div className="panel-header">
					{!filesCollapsed && <h2>Files</h2>}
					<button
						className="icon-btn"
						type="button"
						onClick={() => setFilesCollapsed((previous) => !previous)}
						aria-label={filesCollapsed ? "Expand files" : "Collapse files"}
						title={filesCollapsed ? "Expand files" : "Collapse files"}
					>
						{filesCollapsed ? "»" : "«"}
					</button>
				</div>

				<div className="panel-body scroll-y">
					{currentFiles.map((file) => {
						const renderable = isRenderableFile(file.name);
						return (
							<button
								key={file.id}
								type="button"
								className={`list-item ${activeFileDetails?.id === file.id ? "active" : ""}`}
								onClick={() => setActiveFile(file.id)}
							>
								{filesCollapsed ? (
									<span className="mono-index">{file.name.slice(0, 1).toUpperCase()}</span>
								) : (
									<>
										<span className="item-title">{file.name}</span>
										<span className={`status status-${file.status}`}>{file.status}</span>
										<span className="item-meta">{renderable ? "Preview ready" : "Unsupported for preview"}</span>
									</>
								)}
							</button>
						);
					})}
					{!currentFiles.length && !filesCollapsed ? <p className="empty-note">No files in this session.</p> : null}
				</div>
			</section>

			<section className="content-shell">
				<div className="content-grid">
					<aside className="panel panel-chat">
						<div className="panel-header">
							<h2>Chat</h2>
						</div>
						<div className="panel-body chat-thread">
							{messages.map((message) => (
								<div key={message.id} className={`chat-bubble ${message.role}`}>
									{message.text}
								</div>
							))}
							{chatPending ? <div className="chat-bubble assistant">Thinking...</div> : null}
						</div>
						<div className="chat-input-wrap">
							<input
								type="text"
								placeholder="Ask to rewrite, summarize, or explain with context..."
								aria-label="Chat input"
								value={chatInput}
								disabled={chatPending}
								onChange={(event) => setChatInput(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										void sendChatMessage();
									}
								}}
							/>
							<button type="button" onClick={() => void sendChatMessage()} disabled={chatPending || !chatInput.trim()}>
								{chatPending ? "Sending..." : "Send"}
							</button>
						</div>
					</aside>

					<article className="panel panel-preview">
						<div className="panel-header">
							<h2>Preview</h2>
							<div className="preview-header-actions">
								{renderedDocument ? <span className="status">{previewPages.length} page(s)</span> : <span className="status">{renderableFiles.length} previewable</span>}
								{renderedDocument && previewPages.some((page) => page.sentences?.length) ? (
									<button
										type="button"
										className={`play-btn ${isReadingAll ? "is-playing" : ""}`}
										onClick={readAllSentences}
										aria-label={isReadingAll ? "Stop reading the file" : "Read the file aloud"}
										title={isReadingAll ? "Stop reading the file" : "Read the file aloud"}
									>
										{isReadingAll ? "■ Stop" : "▶ Read"}
									</button>
								) : null}
							</div>
						</div>
						<div className="panel-body scroll-y preview-body">
							{!activeSessionDetails ? <p className="empty-note">Open a folder to preview Markdown, PDF, DOCX, and PPTX files.</p> : null}
							{previewError ? <p className="error-note">{previewError}</p> : null}
							{isLoadingPreview ? <p className="empty-note">Rendering preview in backend...</p> : null}
							{!isLoadingPreview && renderedDocument ? (
								<div className="preview-stack">
									{previewPages.map((page) => (
										<figure className="preview-figure" key={`${renderedDocument.sourcePath}-${page.index}`}>
											<div className="preview-page">
												<img className="preview-image" src={page.imageDataUrl} alt={`${renderedDocument.fileName} ${page.label}`} />
												{page.sentences?.length ? (
													<div className="preview-textlayer">
														{page.sentences.map((sentence) =>
															sentence.rects.map((rect, rectIndex) => (
																<button
																	key={`${sentence.id}-${rectIndex}`}
																	type="button"
																	className={`preview-sentence ${activeSentenceKey === `${page.index}:${sentence.id}` ? "active" : ""}`}
																	style={{
																		left: `${rect.left}%`,
																		top: `${rect.top}%`,
																		width: `${rect.width}%`,
																		height: `${rect.height}%`,
																	}}
																	title="Click to read this sentence aloud"
																	aria-label={`Read aloud: ${sentence.text}`}
																	onClick={() => speakSentence(page.index, sentence)}
																/>
															)),
														)}
													</div>
												) : null}
											</div>
										</figure>
									))}
								</div>
							) : null}
						</div>
					</article>
				</div>
			</section>
		</main>
	);
}

export default App;
