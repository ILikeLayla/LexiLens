import type React from "react";
import type {
    ChatMessage,
    PreviewSentence,
    RenderedDocument,
    RenderedPage,
    SessionFile,
    SessionItem,
} from "./types";

type FilesPanelProps = {
    filesCollapsed: boolean;
    currentFiles: SessionFile[];
    activeFileId: string;
    showSessionMenu: boolean;
    activeSession: string;
    activeSessionDetails: SessionItem | null;
    sessions: SessionItem[];
    loadingFolder: boolean;
    appError: string | null;
    onToggleFilesCollapsed: () => void;
    onSelectFile: (fileId: string) => void;
    onToggleSessionMenu: () => void;
    onOpenFolderAsSession: () => void;
    onOpenSettings: () => void;
    onSelectSession: (sessionId: string) => void;
    onOpenFolderFromMenu: () => void;
};

export function FilesPanel({
    filesCollapsed,
    currentFiles,
    activeFileId,
    showSessionMenu,
    activeSession,
    activeSessionDetails,
    sessions,
    loadingFolder,
    appError,
    onToggleFilesCollapsed,
    onSelectFile,
    onToggleSessionMenu,
    onOpenFolderAsSession,
    onOpenSettings,
    onSelectSession,
    onOpenFolderFromMenu,
}: FilesPanelProps) {
    return (
        <section
            className={`panel panel-files ${filesCollapsed ? "is-collapsed" : ""}`}
        >
            <div className="panel-header">
                {!filesCollapsed && <h2>Files</h2>}
                <button
                    className="icon-btn"
                    type="button"
                    onClick={onToggleFilesCollapsed}
                    aria-label={
                        filesCollapsed ? "Expand files" : "Collapse files"
                    }
                    title={filesCollapsed ? "Expand files" : "Collapse files"}
                >
                    {filesCollapsed ? "»" : "«"}
                </button>
            </div>

            <div className="panel-body files-panel-body">
                <div className="scroll-y files-list">
                    {currentFiles.map((file) => (
                        <button
                            key={file.id}
                            type="button"
                            className={`list-item ${activeFileId === file.id ? "active" : ""}`}
                            onClick={() => onSelectFile(file.id)}
                        >
                            {filesCollapsed ? (
                                <span className="mono-index">
                                    {file.name.slice(0, 1).toUpperCase()}
                                </span>
                            ) : (
                                <span className="item-title">{file.name}</span>
                            )}
                        </button>
                    ))}
                    {!currentFiles.length && !filesCollapsed ? (
                        <p className="empty-note">No files in this session.</p>
                    ) : null}
                </div>

                <div
                    className={`session-switcher ${showSessionMenu ? "is-open" : ""}`}
                >
                    <div className="session-switcher-bar">
                        {activeSessionDetails ? (
                            <button
                                type="button"
                                className={`list-item session-current-btn ${showSessionMenu ? "active" : ""}`}
                                onClick={onToggleSessionMenu}
                                aria-expanded={showSessionMenu}
                                aria-label={
                                    showSessionMenu
                                        ? "Hide other sessions"
                                        : "Show other sessions"
                                }
                            >
                                {filesCollapsed ? (
                                    <span className="mono-index">
                                        {activeSessionDetails.title
                                            .slice(0, 1)
                                            .toUpperCase()}
                                    </span>
                                ) : (
                                    <span className="item-title">
                                        {activeSessionDetails.title}
                                    </span>
                                )}
                            </button>
                        ) : (
                            <button
                                className="action-btn session-open-btn"
                                type="button"
                                onClick={onOpenFolderAsSession}
                                disabled={loadingFolder}
                            >
                                {loadingFolder ? "Opening..." : "Open Folder"}
                            </button>
                        )}

                        {!filesCollapsed ? (
                            <button
                                className="icon-btn session-settings-btn"
                                type="button"
                                onClick={onOpenSettings}
                                aria-label="Open settings"
                                title="Settings"
                            >
                                ⚙
                            </button>
                        ) : null}
                    </div>

                    {showSessionMenu && !filesCollapsed ? (
                        <div className="session-menu">
                            <div className="session-menu-section">
                                <div className="session-menu-heading-row">
                                    <span className="session-menu-heading">
                                        Recent Locations
                                    </span>
                                </div>
                                {sessions.map((session) => (
                                    <button
                                        key={session.id}
                                        type="button"
                                        className={`list-item session-menu-item ${activeSession === session.id ? "active" : ""}`}
                                        onClick={() =>
                                            onSelectSession(session.id)
                                        }
                                    >
                                        <span className="item-title">
                                            {session.title}
                                        </span>
                                    </button>
                                ))}
                                {!sessions.length ? (
                                    <p className="empty-note">
                                        No sessions yet.
                                    </p>
                                ) : null}
                            </div>

                            <div className="session-menu-section">
                                <span className="session-menu-heading">
                                    Location
                                </span>
                                <button
                                    className="session-menu-link"
                                    type="button"
                                    onClick={onOpenFolderFromMenu}
                                    disabled={loadingFolder}
                                >
                                    {loadingFolder
                                        ? "Opening..."
                                        : "Open Folder..."}
                                </button>
                            </div>
                            {appError ? (
                                <p className="error-note">{appError}</p>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            </div>
        </section>
    );
}

type PreviewPanelProps = {
    chatCollapsed: boolean;
    previewTitle: string;
    renderedDocument: RenderedDocument | null;
    previewPages: RenderedPage[];
    renderableFileCount: number;
    isReadingAll: boolean;
    previewZoom: number;
    isDraggingPreview: boolean;
    previewError: string;
    isLoadingPreview: boolean;
    activeSentenceKey: string;
    activeSessionDetails: SessionItem | null;
    previewBodyRef: React.RefObject<HTMLDivElement | null>;
    onExpandChat: () => void;
    onReadAllSentences: () => void;
    onUpdatePreviewZoom: (zoom: number) => void;
    onPreviewPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPreviewPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
    onEndPreviewDrag: (event?: React.PointerEvent<HTMLDivElement>) => void;
    onSpeakSentence: (pageIndex: number, sentence: PreviewSentence) => void;
};

export function PreviewPanel({
    chatCollapsed,
    previewTitle,
    renderedDocument,
    previewPages,
    renderableFileCount,
    isReadingAll,
    previewZoom,
    isDraggingPreview,
    previewError,
    isLoadingPreview,
    activeSentenceKey,
    activeSessionDetails,
    previewBodyRef,
    onExpandChat,
    onReadAllSentences,
    onUpdatePreviewZoom,
    onPreviewPointerDown,
    onPreviewPointerMove,
    onEndPreviewDrag,
    onSpeakSentence,
}: PreviewPanelProps) {
    return (
        <article
            className={`panel panel-preview ${chatCollapsed ? "is-expanded" : ""}`}
        >
            <div className="panel-header">
                <h2 title={previewTitle}>{previewTitle}</h2>
                <div className="preview-header-actions">
                    {renderedDocument ? (
                        <span className="status">
                            {previewPages.length} page(s)
                        </span>
                    ) : (
                        <span className="status">
                            {renderableFileCount} previewable
                        </span>
                    )}
                    {renderedDocument &&
                    previewPages.some((page) => page.sentences?.length) ? (
                        <button
                            type="button"
                            className={`play-btn ${isReadingAll ? "is-playing" : ""}`}
                            onClick={onReadAllSentences}
                            aria-label={
                                isReadingAll
                                    ? "Stop reading the file"
                                    : "Read the file aloud"
                            }
                            title={
                                isReadingAll
                                    ? "Stop reading the file"
                                    : "Read the file aloud"
                            }
                        >
                            {isReadingAll ? "■ Stop" : "▶ Read"}
                        </button>
                    ) : null}
                </div>
            </div>
            {chatCollapsed ? (
                <button
                    className="icon-btn chat-floating-toggle"
                    type="button"
                    onClick={onExpandChat}
                    aria-label="Expand chat"
                    title="Expand chat"
                >
                    Chat
                </button>
            ) : null}
            <div
                className="preview-zoom-controls"
                role="group"
                aria-label="Preview zoom controls"
            >
                <button
                    className="preview-zoom-btn"
                    type="button"
                    onClick={() => onUpdatePreviewZoom(previewZoom - 10)}
                    aria-label="Zoom out"
                >
                    -
                </button>
                <span className="preview-zoom-value">{previewZoom}%</span>
                <button
                    className="preview-zoom-btn"
                    type="button"
                    onClick={() => onUpdatePreviewZoom(previewZoom + 10)}
                    aria-label="Zoom in"
                >
                    +
                </button>
            </div>
            <div
                ref={previewBodyRef}
                className={`panel-body scroll-y preview-body ${previewZoom > 100 ? "is-pannable" : ""} ${isDraggingPreview ? "is-dragging" : ""}`}
                onPointerDown={onPreviewPointerDown}
                onPointerMove={onPreviewPointerMove}
                onPointerUp={(event) => onEndPreviewDrag(event)}
                onPointerCancel={(event) => onEndPreviewDrag(event)}
                onLostPointerCapture={() => onEndPreviewDrag()}
                onDragStart={(event) => event.preventDefault()}
            >
                {!activeSessionDetails ? (
                    <p className="empty-note">
                        Open a folder to preview Markdown, PDF, DOCX, and PPTX
                        files.
                    </p>
                ) : null}
                {previewError ? (
                    <p className="error-note">{previewError}</p>
                ) : null}
                {isLoadingPreview ? (
                    <p className="empty-note">
                        Rendering preview in backend...
                    </p>
                ) : null}
                {!isLoadingPreview && renderedDocument ? (
                    <div
                        className={`preview-stack ${previewZoom > 100 ? "is-zoomed" : ""}`}
                        style={{ width: `${previewZoom}%` }}
                    >
                        {previewPages.map((page) => (
                            <figure
                                className="preview-figure"
                                key={`${renderedDocument.sourcePath}-${page.index}`}
                            >
                                <div className="preview-page">
                                    <img
                                        className="preview-image"
                                        src={page.imageDataUrl}
                                        alt={`${renderedDocument.fileName} ${page.label}`}
                                    />
                                    {page.sentences?.length ? (
                                        <div className="preview-textlayer">
                                            {page.sentences.map((sentence) =>
                                                sentence.rects.map(
                                                    (rect, rectIndex) => (
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
                                                            onClick={() =>
                                                                onSpeakSentence(
                                                                    page.index,
                                                                    sentence,
                                                                )
                                                            }
                                                        />
                                                    ),
                                                ),
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
    );
}

type ChatPanelProps = {
    chatPending: boolean;
    chatInput: string;
    messages: ChatMessage[];
    chatWidth: number;
    onCollapseChat: () => void;
    onChatInputChange: (value: string) => void;
    onSendChatMessage: () => void;
    onChatResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
    onChatResizeMove: (event: React.PointerEvent<HTMLDivElement>) => void;
    onEndChatResize: (event?: React.PointerEvent<HTMLDivElement>) => void;
    renderMarkdown: (text: string) => string;
};

export function ChatPanel({
    chatPending,
    chatInput,
    messages,
    onCollapseChat,
    onChatInputChange,
    onSendChatMessage,
    onChatResizeStart,
    onChatResizeMove,
    onEndChatResize,
    renderMarkdown,
}: ChatPanelProps) {
    return (
        <aside className="panel panel-chat">
            <div
                className="chat-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize chat panel"
                onPointerDown={onChatResizeStart}
                onPointerMove={onChatResizeMove}
                onPointerUp={onEndChatResize}
                onPointerCancel={onEndChatResize}
                onLostPointerCapture={() => onEndChatResize()}
            />
            <div className="panel-header">
                <h2>Chat</h2>
                <div className="panel-header-actions">
                    <button
                        className="icon-btn"
                        type="button"
                        onClick={onCollapseChat}
                        aria-label="Collapse chat"
                        title="Collapse chat"
                    >
                        »
                    </button>
                </div>
            </div>
            <div className="panel-body chat-thread">
                {messages.map((message) => (
                    <div
                        key={message.id}
                        className={`chat-bubble ${message.role}`}
                    >
                        {message.role === "assistant" ? (
                            <div
                                className="chat-markdown"
                                dangerouslySetInnerHTML={{
                                    __html: renderMarkdown(message.text),
                                }}
                            />
                        ) : (
                            message.text
                        )}
                    </div>
                ))}
                {chatPending ? (
                    <div className="chat-bubble assistant">Thinking...</div>
                ) : null}
            </div>
            <div className="chat-input-wrap">
                <input
                    type="text"
                    placeholder="Ask to rewrite, summarize, or explain with context..."
                    aria-label="Chat input"
                    value={chatInput}
                    disabled={chatPending}
                    onChange={(event) => onChatInputChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            onSendChatMessage();
                        }
                    }}
                />
                <button
                    type="button"
                    onClick={onSendChatMessage}
                    disabled={chatPending || !chatInput.trim()}
                >
                    {chatPending ? "Sending..." : "Send"}
                </button>
            </div>
        </aside>
    );
}
