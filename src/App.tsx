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

interface ChatMessage {
  id: string;
  role: "assistant" | "user";
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

  const messages: ChatMessage[] = [
    {
      id: "m-1",
      role: "assistant",
      text: "I condensed the latest paragraph and kept all domain terms unchanged.",
    },
    {
      id: "m-2",
      role: "user",
      text: "Great. Make it easier for grade 8 but keep the definitions section.",
    },
    {
      id: "m-3",
      role: "assistant",
      text: "Done. I lowered sentence complexity and preserved the glossary block.",
    },
  ];

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
            </div>
            <div className="chat-input-wrap">
              <input type="text" placeholder="Ask to rewrite, summarize, or speak..." aria-label="Chat input" />
              <button type="button">Send</button>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}

export default App;
