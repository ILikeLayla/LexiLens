import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { startTransition, useEffect, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./App.css";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type SessionFile = {
	id: string;
	name: string;
	status: string;
};

type FolderSession = {
	id: string;
	title: string;
	updatedAt: string;
	path: string;
	files: SessionFile[];
};

type RenderedPage = {
	index: number;
	title: string;
	label: string;
	imageDataUrl: string;
	width: number;
	height: number;
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

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
	const base64 = dataUrl.split(",", 2)[1] ?? "";
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
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

		pages.push({
			index: pageNumber - 1,
			title: previewDocument.fileName,
			label: `${previewDocument.format.toUpperCase()} page ${pageNumber}`,
			imageDataUrl: canvas.toDataURL("image/png"),
			width: canvas.width,
			height: canvas.height,
		});
	}

	return pages;
}

function App() {
	const [session, setSession] = useState<FolderSession | null>(null);
	const [activeFileName, setActiveFileName] = useState("");
	const [renderedDocument, setRenderedDocument] = useState<RenderedDocument | null>(null);
	const [previewPages, setPreviewPages] = useState<RenderedPage[]>([]);
	const [isLoadingSession, setIsLoadingSession] = useState(false);
	const [isLoadingPreview, setIsLoadingPreview] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");

	const renderableFiles = session?.files.filter((file) => isRenderableFile(file.name)) ?? [];

	useEffect(() => {
		if (!session || !activeFileName) {
			setRenderedDocument(null);
			setPreviewPages([]);
			return;
		}

		if (!isRenderableFile(activeFileName)) {
			setRenderedDocument(null);
			setPreviewPages([]);
			setErrorMessage("Preview supports md, pdf, docx, and pptx files.");
			return;
		}

		let cancelled = false;

		const renderPreview = async () => {
			setIsLoadingPreview(true);
			setErrorMessage("");

			try {
				const document = await invoke<RenderedDocument>("render_active_file", {
					sessionPath: session.path,
					fileName: activeFileName,
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
					setErrorMessage(error instanceof Error ? error.message : String(error));
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
		};
	}, [activeFileName, session]);

	const handleOpenFolder = async () => {
		setIsLoadingSession(true);
		setErrorMessage("");

		try {
			const selected = await open({
				directory: true,
				multiple: false,
				title: "Select a session folder",
			});

			if (!selected || Array.isArray(selected)) {
				return;
			}

			const nextSession = await invoke<FolderSession>("read_folder_session", { path: selected });
			const firstRenderableFile = nextSession.files.find((file) => isRenderableFile(file.name));
			const nextActiveFileName = firstRenderableFile?.name ?? nextSession.files[0]?.name ?? "";

			startTransition(() => {
				setSession(nextSession);
				setActiveFileName(nextActiveFileName);
				setRenderedDocument(null);
				setPreviewPages([]);
			});

			if (!firstRenderableFile && nextSession.files.length > 0) {
				setErrorMessage("No renderable files found in this folder. Supported: md, pdf, docx, pptx.");
			}
		} catch (error) {
			setSession(null);
			setActiveFileName("");
			setRenderedDocument(null);
			setPreviewPages([]);
			setErrorMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setIsLoadingSession(false);
		}
	};

	return (
		<div className="workspace">
			<aside className="panel panel-session">
				<div className="panel-header">
					<h2>Session</h2>
					<button className="icon-btn" type="button" onClick={handleOpenFolder} disabled={isLoadingSession}>
						{isLoadingSession ? "..." : "+"}
					</button>
				</div>
				<div className="panel-body">
					<button className="action-btn" type="button" onClick={handleOpenFolder} disabled={isLoadingSession}>
						{session ? "Change Folder" : "Open Folder"}
					</button>
					{session ? (
						<button className="list-item active" type="button">
							<span className="item-title">{session.title}</span>
							<span className="item-meta">{session.updatedAt}</span>
							<span className="item-meta path">{session.path}</span>
						</button>
					) : (
						<p className="empty-note">Select a folder to load backend previews.</p>
					)}
				</div>
			</aside>

			<aside className="panel panel-files">
				<div className="panel-header">
					<h2>Files</h2>
					<span className="status">{renderableFiles.length} previewable</span>
				</div>
				<div className="panel-body scroll-y">
					{session?.files.length ? (
						session.files.map((file) => {
							const renderable = isRenderableFile(file.name);
							return (
								<button
									key={file.id}
									className={`list-item ${file.name === activeFileName ? "active" : ""}`}
									type="button"
									onClick={() => setActiveFileName(file.name)}
								>
									<span className="item-title">{file.name}</span>
									<span className={`status status-${file.status}`}>{file.status}</span>
									<span className="item-meta">{renderable ? "Preview ready" : "Unsupported for preview"}</span>
								</button>
							);
						})
					) : (
						<p className="empty-note">No files loaded yet.</p>
					)}
				</div>
			</aside>

			<main className="content-shell">
				<div className="content-grid content-grid-single">
					<section className="panel panel-preview">
						<div className="panel-header">
							<h2>Preview</h2>
							{renderedDocument ? <span className="status">{previewPages.length} page(s)</span> : null}
						</div>
						<div className="panel-body scroll-y preview-body">
							{!session ? <p className="empty-note">Open a folder to preview Markdown, PDF, DOCX, and PPTX files.</p> : null}
							{errorMessage ? <p className="error-note">{errorMessage}</p> : null}
							{isLoadingPreview ? <p className="empty-note">Rendering preview in backend...</p> : null}
							{!isLoadingPreview && renderedDocument ? (
								<div className="preview-stack">
									{previewPages.map((page) => (
										<figure className="preview-figure" key={`${renderedDocument.sourcePath}-${page.index}`}>
											<img className="preview-image" src={page.imageDataUrl} alt={`${renderedDocument.fileName} ${page.label}`} />
										</figure>
									))}
								</div>
							) : null}
						</div>
					</section>
				</div>
			</main>
		</div>
	);
}

export default App;
