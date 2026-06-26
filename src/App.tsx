import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

interface SessionItem {
  id: string;
  title: string;
  updatedAt: string;
  path: string;
}

interface SessionFile {
  id: string;
  name: string;
  status: "draft" | "processed" | "raw";
}

interface FolderSessionResponse {
  id: string;
  title: string;
  updatedAt: string;
  path: string;
  files: SessionFile[];
}

interface PersistedAppState {
  sessionCollapsed: boolean;
  filesCollapsed: boolean;
  activeSession: string;
  activeFile: string;
  sessions: SessionItem[];
  filesBySession: Record<string, SessionFile[]>;
}

interface PersistedAppConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

interface ChatRequest {
  userMessage: string;
  sessionTitle?: string;
  sessionPath?: string;
  activeFileName?: string;
  activeFileStatus?: string;
  recentMessages: ChatMessage[];
}

interface ChatResponse {
  provider: string;
  model: string;
  text: string;
}

function App() {
  const [sessionCollapsed, setSessionCollapsed] = useState(false);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [activeSession, setActiveSession] = useState("");
  const [activeFile, setActiveFile] = useState("");
  const [loadingFolder, setLoadingFolder] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [appStateReady, setAppStateReady] = useState(false);

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [filesBySession, setFilesBySession] = useState<Record<string, SessionFile[]>>({});
  const [chatInput, setChatInput] = useState("");
  const [chatPending, setChatPending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "m-1",
      role: "assistant",
      text: "I can now call your configured LLM. Ask with the current session and file context.",
    },
  ]);

  function providerRequiresApiKey(provider: string) {
    const normalized = provider.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    if (normalized.includes("local")) {
      return false;
    }

    return true;
  }

  function collectMissingConfigFields(config: PersistedAppConfig) {
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

  async function ensureRequiredConfigAtStartup() {
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

  useEffect(() => {
    let cancelled = false;

    async function loadAndValidateConfig() {
      try {
        await ensureRequiredConfigAtStartup();
      } catch (error) {
        if (!cancelled) {
          setOpenError(`Settings are incomplete: ${String(error)}`);
        }
      }
    }

    void loadAndValidateConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function restoreAppState() {
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
          setOpenError(`Failed to restore app state: ${String(error)}`);
        }
      } finally {
        if (!cancelled) {
          setAppStateReady(true);
        }
      }
    }

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
      setOpenError((previous) => previous ?? `Failed to save app state: ${String(error)}`);
    });
  }, [activeFile, activeSession, appStateReady, filesBySession, filesCollapsed, sessionCollapsed, sessions]);

  async function openFolderAsSession() {
    setOpenError(null);
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

      const session = await invoke<FolderSessionResponse>("read_folder_session", { path: selected });

      setSessions((previous) => {
        const withoutDuplicate = previous.filter((item) => item.id !== session.id);
        return [{ id: session.id, title: session.title, updatedAt: session.updatedAt, path: session.path }, ...withoutDuplicate];
      });

      setFilesBySession((previous) => ({ ...previous, [session.id]: session.files }));
      setActiveSession(session.id);
      setActiveFile(session.files[0]?.id ?? "");
    } catch (error) {
      setOpenError(String(error));
    } finally {
      setLoadingFolder(false);
    }
  }

  const currentFiles = filesBySession[activeSession] ?? [];
  const activeFileDetails = currentFiles.find((file) => file.id === activeFile) ?? currentFiles[0];
  const activeSessionDetails = sessions.find((session) => session.id === activeSession);

  async function sendChatMessage() {
    const trimmedMessage = chatInput.trim();
    if (!trimmedMessage || chatPending) {
      return;
    }

    setChatPending(true);
    setOpenError(null);

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
      setOpenError((previous) => previous ?? `Chat failed: ${String(error)}`);
    } finally {
      setChatPending(false);
    }
  }

  return (
    <main className="workspace">
      <section className={`panel panel-session ${sessionCollapsed ? "is-collapsed" : ""}`}>
        <div className="panel-header">
          {!sessionCollapsed && <h2>Sessions</h2>}
          <button
            className="icon-btn"
            type="button"
            onClick={() => setSessionCollapsed((prev) => !prev)}
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

          {openError && !sessionCollapsed && <p className="error-note">{openError}</p>}

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

          {!sessions.length && !sessionCollapsed && <p className="empty-note">No sessions yet. Open a folder to begin.</p>}
        </div>
      </section>

      <section className={`panel panel-files ${filesCollapsed ? "is-collapsed" : ""}`}>
        <div className="panel-header">
          {!filesCollapsed && <h2>Files</h2>}
          <button
            className="icon-btn"
            type="button"
            onClick={() => setFilesCollapsed((prev) => !prev)}
            aria-label={filesCollapsed ? "Expand files" : "Collapse files"}
            title={filesCollapsed ? "Expand files" : "Collapse files"}
          >
            {filesCollapsed ? "»" : "«"}
          </button>
        </div>

        <div className="panel-body scroll-y">
          {currentFiles.map((file) => (
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
                </>
              )}
            </button>
          ))}
          {!currentFiles.length && !filesCollapsed && <p className="empty-note">No files in this session.</p>}
        </div>
      </section>

      <section className="content-shell">
        <div className="open-files-bar">Open files: {activeFileDetails?.name ?? "No file selected"}</div>
        <div className="content-grid">
          <article className="panel panel-preview">
            <div className="panel-header">
              <h2>Preview</h2>
            </div>
            <div className="panel-body">
              <p className="preview-title">{activeFileDetails?.name ?? "No file"}</p>
              <p>
                The rewritten draft focuses on shorter sentence structure, lower jargon density, and a consistent
                definition block to support voice playback.
              </p>
              <p>
                This area can render OCR output, highlighted passages, and rewrite results once the pipeline is
                connected.
              </p>
            </div>
          </article>

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
              {chatPending && <div className="chat-bubble assistant">Thinking...</div>}
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
        </div>
      </section>
    </main>
  );
}

export default App;
