import { GlobalWorkerOptions, Util, getDocument } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/display_utils";
import { marked } from "marked";
import DOMPurify from "dompurify";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type {
    PreviewSentence,
    RenderedDocument,
    RenderedPage,
    SentenceRect,
} from "./types";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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

const SENTENCE_TERMINATORS = new Set([
    ".",
    "!",
    "?",
    "\u3002",
    "\uff01",
    "\uff1f",
]);
const CLOSING_PUNCTUATION = "\"')]}\u201d\u2019\u300d\u300f";
const SENTENCE_OPENERS = /[A-Z0-9"'(\[\u201c\u2018\u300c\u300e\u00bf\u00a1]/;

export function renderMarkdown(text: string): string {
    const html = marked.parse(text, {
        async: false,
        gfm: true,
        breaks: true,
    }) as string;
    return DOMPurify.sanitize(html);
}

function computeSentenceRanges(
    text: string,
    forcedBreaks: number[],
): Array<{ start: number; end: number }> {
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
        while (
            boundary < length &&
            (SENTENCE_TERMINATORS.has(text[boundary]) ||
                CLOSING_PUNCTUATION.includes(text[boundary]))
        ) {
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
                const isInitial =
                    rawWord.length === 1 && /[A-Za-z]/.test(rawWord);
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

    const sorted = Array.from(cuts).sort((left, right) => left - right);
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

function buildPageSentences(
    textContent: TextContent,
    viewport: PageViewport,
): PreviewSentence[] {
    let fullText = "";
    const pieces: Array<{ start: number; end: number; rect: SentenceRect }> =
        [];
    const forcedBreaks: number[] = [];
    let previousTop: number | null = null;
    let previousBottom: number | null = null;

    for (const item of textContent.items) {
        if (!("str" in item) || item.str.length === 0) {
            if (
                "hasEOL" in item &&
                item.hasEOL &&
                fullText.length > 0 &&
                !/\s$/.test(fullText)
            ) {
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

        const startsNewLine =
            previousTop !== null && top - previousTop > fontHeight * 0.5;
        const paragraphGap =
            startsNewLine &&
            previousBottom !== null &&
            top - previousBottom > fontHeight * 0.7;

        if (
            fullText.length > 0 &&
            !/\s$/.test(fullText) &&
            !/^\s/.test(item.str)
        ) {
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
        const text = fullText
            .slice(range.start, range.end)
            .replace(/\s+/g, " ")
            .trim();
        if (!text) {
            return;
        }

        const rects = pieces
            .filter(
                (piece) => piece.start < range.end && piece.end > range.start,
            )
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

export async function renderPdfToPages(
    previewDocument: RenderedDocument,
): Promise<RenderedPage[]> {
    if (!previewDocument.pdfDataUrl) {
        return previewDocument.pages;
    }

    const pdf = await getDocument({
        data: dataUrlToUint8Array(previewDocument.pdfDataUrl),
    }).promise;
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
