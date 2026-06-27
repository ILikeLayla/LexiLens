import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { startTransition, useEffect, useRef, useState } from "react";
import "./App.css";
import {
    collectMissingConfigFields,
    DEFAULT_APP_CONFIG,
    normalizeConfig,
    type PersistedAppConfig,
    SettingsPanel,
} from "./Settings";
import { ChatPanel, FilesPanel, PreviewPanel } from "./app/components";
import { renderMarkdown, renderPdfToPages } from "./app/preview";
import {
    CHAT_DEFAULT_WIDTH,
    CHAT_MAX_WIDTH,
    CHAT_MIN_WIDTH,
    type ChatMessage,
    type ChatRequest,
    type ChatResponse,
    type FolderSession,
    type PersistedAppState,
    type RenderedDocument,
    type RenderedPage,
    type SessionFile,
    type SessionItem,
    isRenderableFile,
} from "./app/types";
import { useSpeech } from "./app/useSpeech";

function App() {
    const [sessionCollapsed, setSessionCollapsed] = useState(false);
    const [filesCollapsed, setFilesCollapsed] = useState(false);
    const [chatCollapsed, setChatCollapsed] = useState(false);
    const [showSessionMenu, setShowSessionMenu] = useState(false);
    const [activeSession, setActiveSession] = useState("");
    const [activeFile, setActiveFile] = useState("");
    const [sessions, setSessions] = useState<SessionItem[]>([]);
    const [filesBySession, setFilesBySession] = useState<
        Record<string, SessionFile[]>
    >({});
    const [appStateReady, setAppStateReady] = useState(false);
    const [loadingFolder, setLoadingFolder] = useState(false);
    const [isLoadingPreview, setIsLoadingPreview] = useState(false);
    const [chatPending, setChatPending] = useState(false);
    const [chatInput, setChatInput] = useState("");
    const [previewZoom, setPreviewZoom] = useState(100);
    const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT_WIDTH);
    const [isDraggingPreview, setIsDraggingPreview] = useState(false);
    const [previewPages, setPreviewPages] = useState<RenderedPage[]>([]);
    const [renderedDocument, setRenderedDocument] =
        useState<RenderedDocument | null>(null);
    const previewBodyRef = useRef<HTMLDivElement | null>(null);
    const previewDragRef = useRef({
        pointerId: -1,
        startX: 0,
        startY: 0,
        scrollLeft: 0,
        scrollTop: 0,
        active: false,
    });
    const chatResizeRef = useRef({
        pointerId: -1,
        startX: 0,
        startWidth: CHAT_DEFAULT_WIDTH,
        active: false,
    });
    const [appError, setAppError] = useState<string | null>(null);
    const [previewError, setPreviewError] = useState("");
    const [appConfig, setAppConfig] =
        useState<PersistedAppConfig>(DEFAULT_APP_CONFIG);
    const [showSettings, setShowSettings] = useState(false);
    const [settingsError, setSettingsError] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const {
        activeSentenceKey,
        isReadingAll,
        speakSentence,
        readAllSentences,
        stopReading,
        clearSpeechCache,
    } = useSpeech({ appConfig, previewPages, setAppError });

    const activeSessionDetails =
        sessions.find((session) => session.id === activeSession) ?? null;
    const currentFiles = filesBySession[activeSession] ?? [];
    const activeFileDetails =
        currentFiles.find((file) => file.id === activeFile) ??
        currentFiles[0] ??
        null;
    const renderableFiles = currentFiles.filter((file) =>
        isRenderableFile(file.name),
    );
    const previewTitle =
        activeFileDetails?.name ?? renderedDocument?.fileName ?? "Preview";

    const handleSessionSelect = (sessionId: string) => {
        setActiveSession(sessionId);
        setActiveFile((filesBySession[sessionId] ?? [])[0]?.id ?? "");
        setShowSessionMenu(false);
    };

    const toggleSessionMenu = () => {
        if (filesCollapsed) {
            setFilesCollapsed(false);
            setShowSessionMenu(true);
            return;
        }

        setShowSessionMenu((previous) => !previous);
    };

    const updatePreviewZoom = (nextZoom: number) => {
        setPreviewZoom(Math.max(60, Math.min(200, nextZoom)));
    };

    const handlePreviewPointerDown = (
        event: React.PointerEvent<HTMLDivElement>,
    ) => {
        if (previewZoom <= 100) {
            return;
        }

        const target = event.target as HTMLElement;
        if (
            target.closest(".chat-floating-toggle") ||
            target.closest(".preview-zoom-controls") ||
            target.closest("input") ||
            target.closest("label")
        ) {
            return;
        }

        const container = previewBodyRef.current;
        if (!container) {
            return;
        }

        event.preventDefault();

        previewDragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            scrollLeft: container.scrollLeft,
            scrollTop: container.scrollTop,
            active: true,
        };

        try {
            container.setPointerCapture(event.pointerId);
        } catch {
            // Ignore: pointer capture is best-effort.
        }
        setIsDraggingPreview(true);
    };

    const handlePreviewPointerMove = (
        event: React.PointerEvent<HTMLDivElement>,
    ) => {
        const container = previewBodyRef.current;
        const dragState = previewDragRef.current;
        if (
            !container ||
            !dragState.active ||
            dragState.pointerId !== event.pointerId
        ) {
            return;
        }

        container.scrollLeft =
            dragState.scrollLeft - (event.clientX - dragState.startX);
        container.scrollTop =
            dragState.scrollTop - (event.clientY - dragState.startY);
    };

    const endPreviewDrag = (event?: React.PointerEvent<HTMLDivElement>) => {
        const container = previewBodyRef.current;
        if (
            container &&
            event &&
            previewDragRef.current.pointerId === event.pointerId &&
            container.hasPointerCapture(event.pointerId)
        ) {
            container.releasePointerCapture(event.pointerId);
        }

        previewDragRef.current.active = false;
        previewDragRef.current.pointerId = -1;
        setIsDraggingPreview(false);
    };

    const handleChatResizeStart = (
        event: React.PointerEvent<HTMLDivElement>,
    ) => {
        event.preventDefault();
        chatResizeRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: chatWidth,
            active: true,
        };
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // Ignore: pointer capture is best-effort.
        }
    };

    const handleChatResizeMove = (
        event: React.PointerEvent<HTMLDivElement>,
    ) => {
        const drag = chatResizeRef.current;
        if (!drag.active || drag.pointerId !== event.pointerId) {
            return;
        }
        const delta = drag.startX - event.clientX;
        const next = Math.min(
            CHAT_MAX_WIDTH,
            Math.max(CHAT_MIN_WIDTH, drag.startWidth + delta),
        );
        setChatWidth(next);
    };

    const endChatResize = (event?: React.PointerEvent<HTMLDivElement>) => {
        const drag = chatResizeRef.current;
        if (!drag.active) {
            return;
        }
        if (
            event &&
            drag.pointerId === event.pointerId &&
            event.currentTarget.hasPointerCapture(event.pointerId)
        ) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        chatResizeRef.current = { ...drag, active: false, pointerId: -1 };
    };

    useEffect(() => {
        let cancelled = false;

        const loadAndValidateConfig = async () => {
            try {
                const loaded =
                    await invoke<Partial<PersistedAppConfig>>(
                        "load_app_config",
                    );
                if (cancelled) {
                    return;
                }

                const config = normalizeConfig(loaded);
                setAppConfig(config);

                const missingFields = collectMissingConfigFields(config);
                if (missingFields.length) {
                    setSettingsError(
                        `Some required settings are missing: ${missingFields.join(", ")}. Please complete them to continue.`,
                    );
                    setShowSettings(true);
                }
            } catch (error) {
                if (!cancelled) {
                    setAppError(`Failed to load settings: ${String(error)}`);
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
                const persistedState = await invoke<PersistedAppState | null>(
                    "load_app_state",
                );
                if (cancelled || !persistedState) {
                    return;
                }

                setSessionCollapsed(persistedState.sessionCollapsed ?? false);
                setFilesCollapsed(persistedState.filesCollapsed ?? false);
                setChatCollapsed(persistedState.chatCollapsed ?? false);
                setActiveSession(persistedState.activeSession);
                setActiveFile(persistedState.activeFile);
                setSessions(persistedState.sessions);
                setFilesBySession(persistedState.filesBySession);
                if (persistedState.previewZoom) {
                    setPreviewZoom(persistedState.previewZoom);
                }
                if (persistedState.chatWidth) {
                    setChatWidth(
                        Math.min(
                            CHAT_MAX_WIDTH,
                            Math.max(CHAT_MIN_WIDTH, persistedState.chatWidth),
                        ),
                    );
                }
                if (persistedState.messages?.length) {
                    setMessages(persistedState.messages);
                }
            } catch (error) {
                if (!cancelled) {
                    setAppError(
                        `Failed to restore app state: ${String(error)}`,
                    );
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
            chatCollapsed,
            activeSession,
            activeFile,
            sessions,
            filesBySession,
            previewZoom,
            chatWidth,
            messages,
        };

        void invoke("save_app_state", { state: persistedState }).catch(
            (error) => {
                setAppError(
                    (previous) =>
                        previous ??
                        `Failed to save app state: ${String(error)}`,
                );
            },
        );
    }, [
        activeFile,
        activeSession,
        appStateReady,
        chatCollapsed,
        chatWidth,
        filesBySession,
        filesCollapsed,
        messages,
        previewZoom,
        sessionCollapsed,
        sessions,
    ]);

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
                const document = await invoke<RenderedDocument>(
                    "render_active_file",
                    {
                        sessionPath: activeSessionDetails.path,
                        fileName: activeFileDetails.name,
                    },
                );
                const pages = document.pdfDataUrl
                    ? await renderPdfToPages(document)
                    : document.pages;

                if (!cancelled) {
                    setRenderedDocument(document);
                    setPreviewPages(pages);
                }
            } catch (error) {
                if (!cancelled) {
                    setRenderedDocument(null);
                    setPreviewPages([]);
                    setPreviewError(
                        error instanceof Error ? error.message : String(error),
                    );
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
            stopReading();
            clearSpeechCache();
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

            const nextSession = await invoke<FolderSession>(
                "read_folder_session",
                { path: selected },
            );
            const nextRenderableFile = nextSession.files.find((file) =>
                isRenderableFile(file.name),
            );

            startTransition(() => {
                setSessions((previous) => {
                    const withoutDuplicate = previous.filter(
                        (item) => item.id !== nextSession.id,
                    );
                    return [
                        {
                            id: nextSession.id,
                            title: nextSession.title,
                            updatedAt: nextSession.updatedAt,
                            path: nextSession.path,
                        },
                        ...withoutDuplicate,
                    ];
                });
                setFilesBySession((previous) => ({
                    ...previous,
                    [nextSession.id]: nextSession.files,
                }));
                setActiveSession(nextSession.id);
                setActiveFile(
                    nextRenderableFile?.id ?? nextSession.files[0]?.id ?? "",
                );
                setRenderedDocument(null);
                setPreviewPages([]);
            });

            if (!nextRenderableFile && nextSession.files.length > 0) {
                setPreviewError(
                    "No renderable files found in this folder. Supported: md, pdf, docx, pptx.",
                );
            }
        } catch (error) {
            setAppError(String(error));
        } finally {
            setLoadingFolder(false);
        }
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

            const response = await invoke<ChatResponse>("chat_with_context", {
                request,
            });
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
            setAppError(
                (previous) => previous ?? `Chat failed: ${String(error)}`,
            );
        } finally {
            setChatPending(false);
        }
    };

    return (
        <main className="workspace">
            <FilesPanel
                filesCollapsed={filesCollapsed}
                currentFiles={currentFiles}
                activeFileId={activeFileDetails?.id ?? ""}
                showSessionMenu={showSessionMenu}
                activeSession={activeSession}
                activeSessionDetails={activeSessionDetails}
                sessions={sessions}
                loadingFolder={loadingFolder}
                appError={appError}
                onToggleFilesCollapsed={() =>
                    setFilesCollapsed((previous) => !previous)
                }
                onSelectFile={setActiveFile}
                onToggleSessionMenu={toggleSessionMenu}
                onOpenFolderAsSession={() => {
                    void openFolderAsSession();
                }}
                onOpenSettings={() => {
                    setSettingsError(null);
                    setShowSettings(true);
                }}
                onSelectSession={handleSessionSelect}
                onOpenFolderFromMenu={() => {
                    setShowSessionMenu(false);
                    void openFolderAsSession();
                }}
            />

            <section className="content-shell">
                <div
                    className={`content-grid ${chatCollapsed ? "content-grid-single" : ""}`}
                    style={
                        chatCollapsed
                            ? undefined
                            : {
                                  gridTemplateColumns: `minmax(0, 1fr) ${chatWidth}px`,
                              }
                    }
                >
                    <PreviewPanel
                        chatCollapsed={chatCollapsed}
                        previewTitle={previewTitle}
                        renderedDocument={renderedDocument}
                        previewPages={previewPages}
                        renderableFileCount={renderableFiles.length}
                        isReadingAll={isReadingAll}
                        previewZoom={previewZoom}
                        isDraggingPreview={isDraggingPreview}
                        previewError={previewError}
                        isLoadingPreview={isLoadingPreview}
                        activeSentenceKey={activeSentenceKey}
                        activeSessionDetails={activeSessionDetails}
                        previewBodyRef={previewBodyRef}
                        onExpandChat={() => setChatCollapsed(false)}
                        onReadAllSentences={readAllSentences}
                        onUpdatePreviewZoom={updatePreviewZoom}
                        onPreviewPointerDown={handlePreviewPointerDown}
                        onPreviewPointerMove={handlePreviewPointerMove}
                        onEndPreviewDrag={endPreviewDrag}
                        onSpeakSentence={speakSentence}
                    />

                    {!chatCollapsed ? (
                        <ChatPanel
                            chatPending={chatPending}
                            chatInput={chatInput}
                            messages={messages}
                            chatWidth={chatWidth}
                            onCollapseChat={() => setChatCollapsed(true)}
                            onChatInputChange={setChatInput}
                            onSendChatMessage={() => {
                                void sendChatMessage();
                            }}
                            onChatResizeStart={handleChatResizeStart}
                            onChatResizeMove={handleChatResizeMove}
                            onEndChatResize={endChatResize}
                            renderMarkdown={renderMarkdown}
                        />
                    ) : null}
                </div>
            </section>

            {showSettings ? (
                <SettingsPanel
                    config={appConfig}
                    initialError={settingsError}
                    onClose={() => {
                        setShowSettings(false);
                        setSettingsError(null);
                    }}
                    onSaved={(savedConfig) => {
                        setAppConfig(savedConfig);
                        setShowSettings(false);
                        setSettingsError(null);
                        clearSpeechCache();
                    }}
                />
            ) : null}
        </main>
    );
}

export default App;
