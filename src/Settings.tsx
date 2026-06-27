import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

export type PersistedAppConfig = {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    ttsModel: string;
    ttsVoice: string;
    ttsMode: string;
    preprocessTtsWithLlm: boolean;
    ttsRequestTimeoutMs: number;
    ttsMaxRetries: number;
    speechCacheLimit: number;
};

export const DEFAULT_APP_CONFIG: PersistedAppConfig = {
    provider: "openai-compatible",
    apiKey: "",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    ttsModel: "gemini-2.5-flash-preview-tts",
    ttsVoice: "Kore",
    ttsMode: "remote",
    preprocessTtsWithLlm: true,
    ttsRequestTimeoutMs: 8000,
    ttsMaxRetries: 2,
    speechCacheLimit: 7,
};

const PROVIDER_OPTIONS = [
    { value: "openai-compatible", label: "OpenAI-compatible (remote API)" },
    { value: "local", label: "Local runtime" },
];

const TTS_MODE_OPTIONS = [
    { value: "remote", label: "Remote (provider TTS)" },
    { value: "local", label: "Local (built-in browser voice)" },
];

export function normalizeConfig(
    raw: Partial<PersistedAppConfig> | null | undefined,
): PersistedAppConfig {
    return {
        provider: raw?.provider ?? DEFAULT_APP_CONFIG.provider,
        apiKey: raw?.apiKey ?? DEFAULT_APP_CONFIG.apiKey,
        baseUrl: raw?.baseUrl ?? DEFAULT_APP_CONFIG.baseUrl,
        model: raw?.model ?? DEFAULT_APP_CONFIG.model,
        ttsModel: raw?.ttsModel ?? DEFAULT_APP_CONFIG.ttsModel,
        ttsVoice: raw?.ttsVoice ?? DEFAULT_APP_CONFIG.ttsVoice,
        ttsMode: raw?.ttsMode ?? DEFAULT_APP_CONFIG.ttsMode,
        preprocessTtsWithLlm:
            typeof raw?.preprocessTtsWithLlm === "boolean"
                ? raw.preprocessTtsWithLlm
                : DEFAULT_APP_CONFIG.preprocessTtsWithLlm,
        ttsRequestTimeoutMs:
            typeof raw?.ttsRequestTimeoutMs === "number" &&
            Number.isFinite(raw.ttsRequestTimeoutMs)
                ? raw.ttsRequestTimeoutMs
                : DEFAULT_APP_CONFIG.ttsRequestTimeoutMs,
        ttsMaxRetries:
            typeof raw?.ttsMaxRetries === "number" &&
            Number.isFinite(raw.ttsMaxRetries)
                ? raw.ttsMaxRetries
                : DEFAULT_APP_CONFIG.ttsMaxRetries,
        speechCacheLimit:
            typeof raw?.speechCacheLimit === "number" &&
            Number.isFinite(raw.speechCacheLimit)
                ? raw.speechCacheLimit
                : DEFAULT_APP_CONFIG.speechCacheLimit,
    };
}

function providerRequiresApiKey(provider: string): boolean {
    const normalized = provider.trim().toLowerCase();
    return normalized.length > 0 && !normalized.includes("local");
}

export function collectMissingConfigFields(
    config: PersistedAppConfig,
): Array<keyof PersistedAppConfig> {
    const missingFields: Array<keyof PersistedAppConfig> = [];

    if (!config.provider.trim()) {
        missingFields.push("provider");
    }

    if (providerRequiresApiKey(config.provider) && !config.apiKey.trim()) {
        missingFields.push("apiKey");
    }

    if (
        config.provider.trim().toLowerCase() === "openai-compatible" &&
        !config.baseUrl.trim()
    ) {
        missingFields.push("baseUrl");
    }

    if (!config.model.trim()) {
        missingFields.push("model");
    }

    return missingFields;
}

type SettingsPanelProps = {
    config: PersistedAppConfig;
    initialError?: string | null;
    onClose: () => void;
    onSaved: (config: PersistedAppConfig) => void;
};

export function SettingsPanel({
    config,
    initialError,
    onClose,
    onSaved,
}: SettingsPanelProps) {
    const [draft, setDraft] = useState<PersistedAppConfig>(config);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(initialError ?? null);

    const isRemoteProvider =
        draft.provider.trim().toLowerCase() === "openai-compatible";
    const needsApiKey = providerRequiresApiKey(draft.provider);
    const isRemoteTts = draft.ttsMode.trim().toLowerCase() !== "local";

    const update = <K extends keyof PersistedAppConfig>(
        key: K,
        value: PersistedAppConfig[K],
    ) => {
        setDraft((previous) => ({ ...previous, [key]: value }));
    };

    const handleSave = async () => {
        const sanitized: PersistedAppConfig = {
            ...draft,
            provider: draft.provider.trim(),
            apiKey: draft.apiKey.trim(),
            baseUrl: draft.baseUrl.trim(),
            model: draft.model.trim(),
            ttsModel: draft.ttsModel.trim(),
            ttsVoice: draft.ttsVoice.trim(),
            ttsMode:
                draft.ttsMode.trim().toLowerCase() === "local"
                    ? "local"
                    : "remote",
            preprocessTtsWithLlm: Boolean(draft.preprocessTtsWithLlm),
            ttsRequestTimeoutMs: Math.max(
                500,
                Math.min(120000, Math.round(draft.ttsRequestTimeoutMs) || 500),
            ),
            ttsMaxRetries: Math.max(
                0,
                Math.min(10, Math.round(draft.ttsMaxRetries) || 0),
            ),
            speechCacheLimit: Math.max(
                1,
                Math.min(100, Math.round(draft.speechCacheLimit) || 1),
            ),
        };

        const missing = collectMissingConfigFields(sanitized);
        if (missing.length) {
            setError(
                `Please fill in required settings: ${missing.join(", ")}.`,
            );
            return;
        }

        setSaving(true);
        setError(null);

        try {
            await invoke("save_app_config", { config: sanitized });
            onSaved(sanitized);
        } catch (saveError) {
            setError(`Failed to save settings: ${String(saveError)}`);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div
            className="settings-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
        >
            <div className="settings-modal">
                <div className="settings-modal-header">
                    <h2>Settings</h2>
                    <button
                        className="icon-btn"
                        type="button"
                        onClick={onClose}
                        aria-label="Close settings"
                        title="Close"
                    >
                        ✕
                    </button>
                </div>

                <div className="settings-modal-body scroll-y">
                    {error ? <p className="error-note">{error}</p> : null}

                    <section className="settings-group">
                        <h3>Language model</h3>

                        <label className="settings-field">
                            <span className="settings-label">Provider</span>
                            <select
                                value={draft.provider}
                                onChange={(event) =>
                                    update("provider", event.target.value)
                                }
                            >
                                {PROVIDER_OPTIONS.map((option) => (
                                    <option
                                        key={option.value}
                                        value={option.value}
                                    >
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="settings-field">
                            <span className="settings-label">Model</span>
                            <input
                                type="text"
                                value={draft.model}
                                placeholder="e.g. gemini-2.5-flash, gpt-4o-mini"
                                onChange={(event) =>
                                    update("model", event.target.value)
                                }
                            />
                        </label>

                        {needsApiKey ? (
                            <label className="settings-field">
                                <span className="settings-label">API key</span>
                                <input
                                    type="password"
                                    value={draft.apiKey}
                                    placeholder="Paste your provider API key"
                                    autoComplete="off"
                                    onChange={(event) =>
                                        update("apiKey", event.target.value)
                                    }
                                />
                            </label>
                        ) : null}

                        {isRemoteProvider ? (
                            <label className="settings-field">
                                <span className="settings-label">Base URL</span>
                                <input
                                    type="text"
                                    value={draft.baseUrl}
                                    placeholder="https://api.openai.com/v1"
                                    onChange={(event) =>
                                        update("baseUrl", event.target.value)
                                    }
                                />
                                <span className="settings-hint">
                                    OpenAI-compatible endpoint. Gemini:
                                    https://generativelanguage.googleapis.com/v1beta/openai
                                </span>
                            </label>
                        ) : null}
                    </section>

                    <section className="settings-group">
                        <h3>Text to speech</h3>

                        <label className="settings-field">
                            <span className="settings-label">Mode</span>
                            <select
                                value={draft.ttsMode}
                                onChange={(event) =>
                                    update("ttsMode", event.target.value)
                                }
                            >
                                {TTS_MODE_OPTIONS.map((option) => (
                                    <option
                                        key={option.value}
                                        value={option.value}
                                    >
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                            <span className="settings-hint">
                                Local uses your operating system / browser
                                voice. Remote uses the provider's TTS model.
                            </span>
                        </label>

                        <label className="settings-field">
                            <span className="settings-label">
                                LLM sentence preprocessing
                            </span>
                            <select
                                value={draft.preprocessTtsWithLlm ? "on" : "off"}
                                onChange={(event) =>
                                    update(
                                        "preprocessTtsWithLlm",
                                        event.target.value === "on",
                                    )
                                }
                            >
                                <option value="on">
                                    On (edit sentence before TTS)
                                </option>
                                <option value="off">
                                    Off (send sentence directly to TTS)
                                </option>
                            </select>
                            <span className="settings-hint">
                                When off, text is spoken as-is without LLM
                                rewrite.
                            </span>
                        </label>

                        {isRemoteTts ? (
                            <>
                                <label className="settings-field">
                                    <span className="settings-label">
                                        TTS model
                                    </span>
                                    <input
                                        type="text"
                                        value={draft.ttsModel}
                                        placeholder="e.g. gemini-2.5-flash-preview-tts"
                                        onChange={(event) =>
                                            update(
                                                "ttsModel",
                                                event.target.value,
                                            )
                                        }
                                    />
                                    <span className="settings-hint">
                                        Leave empty to use the built-in browser
                                        voice as a fallback.
                                    </span>
                                </label>

                                <label className="settings-field">
                                    <span className="settings-label">
                                        Voice
                                    </span>
                                    <input
                                        type="text"
                                        value={draft.ttsVoice}
                                        placeholder="e.g. Kore"
                                        onChange={(event) =>
                                            update(
                                                "ttsVoice",
                                                event.target.value,
                                            )
                                        }
                                    />
                                </label>

                                <label className="settings-field">
                                    <span className="settings-label">
                                        TTS request timeout (ms)
                                    </span>
                                    <input
                                        type="number"
                                        min={500}
                                        max={120000}
                                        step={100}
                                        value={draft.ttsRequestTimeoutMs}
                                        onChange={(event) =>
                                            update(
                                                "ttsRequestTimeoutMs",
                                                Number(event.target.value),
                                            )
                                        }
                                    />
                                    <span className="settings-hint">
                                        Max wait per remote TTS attempt before
                                        trying again or falling back to local.
                                    </span>
                                </label>

                                <label className="settings-field">
                                    <span className="settings-label">
                                        TTS max retries
                                    </span>
                                    <input
                                        type="number"
                                        min={0}
                                        max={10}
                                        step={1}
                                        value={draft.ttsMaxRetries}
                                        onChange={(event) =>
                                            update(
                                                "ttsMaxRetries",
                                                Number(event.target.value),
                                            )
                                        }
                                    />
                                    <span className="settings-hint">
                                        Number of retries after the first
                                        remote TTS attempt. Set 0 to disable
                                        retries.
                                    </span>
                                </label>
                            </>
                        ) : null}
                    </section>

                    <section className="settings-group">
                        <h3>Performance</h3>

                        <label className="settings-field">
                            <span className="settings-label">
                                Speech cache size
                            </span>
                            <input
                                type="number"
                                min={1}
                                max={100}
                                value={draft.speechCacheLimit}
                                onChange={(event) =>
                                    update(
                                        "speechCacheLimit",
                                        Number(event.target.value),
                                    )
                                }
                            />
                            <span className="settings-hint">
                                Number of recently synthesized sentences kept in
                                memory (1–100).
                            </span>
                        </label>
                    </section>
                </div>

                <div className="settings-modal-footer">
                    <button
                        className="action-btn ghost"
                        type="button"
                        onClick={onClose}
                        disabled={saving}
                    >
                        Cancel
                    </button>
                    <button
                        className="action-btn"
                        type="button"
                        onClick={() => void handleSave()}
                        disabled={saving}
                    >
                        {saving ? "Saving..." : "Save settings"}
                    </button>
                </div>
            </div>
        </div>
    );
}
