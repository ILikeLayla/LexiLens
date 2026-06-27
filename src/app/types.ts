export const CHAT_MIN_WIDTH = 260;
export const CHAT_MAX_WIDTH = 720;
export const CHAT_DEFAULT_WIDTH = 330;

export type SessionItem = {
    id: string;
    title: string;
    updatedAt: string;
    path: string;
};

export type SessionFile = {
    id: string;
    name: string;
    status: "draft" | "processed" | "raw";
};

export type FolderSession = {
    id: string;
    title: string;
    updatedAt: string;
    path: string;
    files: SessionFile[];
};

export type ChatMessage = {
    id: string;
    role: "assistant" | "user";
    text: string;
};

export type PersistedAppState = {
    sessionCollapsed: boolean;
    filesCollapsed: boolean;
    chatCollapsed: boolean;
    activeSession: string;
    activeFile: string;
    sessions: SessionItem[];
    filesBySession: Record<string, SessionFile[]>;
    previewZoom: number;
    chatWidth: number;
    messages: ChatMessage[];
};

export type ChatRequest = {
    userMessage: string;
    sessionTitle?: string;
    sessionPath?: string;
    activeFileName?: string;
    activeFileStatus?: string;
    recentMessages: ChatMessage[];
};

export type ChatResponse = {
    provider: string;
    model: string;
    text: string;
};

export type SentenceRect = {
    left: number;
    top: number;
    width: number;
    height: number;
};

export type PreviewSentence = {
    id: string;
    text: string;
    rects: SentenceRect[];
};

export type SynthesizedSpeech = {
    mimeType: string;
    audioBase64: string;
};

export type PreparedSpeech = {
    text: string;
    audio: SynthesizedSpeech | null;
};

export type RenderedPage = {
    index: number;
    title: string;
    label: string;
    imageDataUrl: string;
    width: number;
    height: number;
    sentences?: PreviewSentence[];
};

export type RenderedDocument = {
    sourcePath: string;
    fileName: string;
    format: string;
    pdfDataUrl: string | null;
    pages: RenderedPage[];
};

const SUPPORTED_EXTENSIONS = new Set(["md", "pdf", "docx", "pptx"]);

export function getFileExtension(fileName: string): string {
    const segments = fileName.toLowerCase().split(".");
    return segments.length > 1 ? segments[segments.length - 1] : "";
}

export function isRenderableFile(fileName: string): boolean {
    return SUPPORTED_EXTENSIONS.has(getFileExtension(fileName));
}
