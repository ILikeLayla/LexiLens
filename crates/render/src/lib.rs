mod office;
mod text;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::Path;

use office::convert_office_source_to_pdf;
use text::{extract_office_text, extract_pdf_text, render_markdown};

const SVG_WIDTH: usize = 1200;
const SVG_HEIGHT: usize = 1600;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPage {
    pub index: usize,
    pub title: String,
    pub label: String,
    pub image_data_url: String,
    pub width: usize,
    pub height: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedDocument {
    pub source_path: String,
    pub file_name: String,
    pub format: String,
    pub pdf_data_url: Option<String>,
    pub pages: Vec<RenderedPage>,
}

struct PageDraft {
    title: String,
    label: String,
    lines: Vec<String>,
}

pub fn render_document(path: &Path) -> Result<RenderedDocument, String> {
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "File extension is required for preview rendering".to_string())?;

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document")
        .to_string();

    let drafts = match extension.as_str() {
        "md" => render_markdown(path)?,
        "pdf" | "docx" | "pptx" => Vec::new(),
        _ => {
            return Err(format!(
                "Unsupported preview format '{extension}'. Supported formats: md, pdf, docx, pptx."
            ));
        }
    };

    let pdf_data_url = match extension.as_str() {
        "pdf" => Some(read_pdf_data_url(path)?),
        "docx" | "pptx" => Some(convert_office_source_to_pdf_data_url(path, &extension)?),
        _ => None,
    };

    let total_pages = drafts.len().max(1);
    let pages = drafts
        .into_iter()
        .enumerate()
        .map(|(index, draft)| RenderedPage {
            index,
            title: draft.title.clone(),
            label: draft.label.clone(),
            image_data_url: render_svg_data_url(&file_name, &draft, index + 1, total_pages),
            width: SVG_WIDTH,
            height: SVG_HEIGHT,
        })
        .collect();

    Ok(RenderedDocument {
        source_path: path.display().to_string(),
        file_name,
        format: extension,
        pdf_data_url,
        pages,
    })
}

/// Extract the plain-text contents of a document for analysis or summarization.
///
/// Supports text-based files directly, PDFs via `pdf-extract`, and Office
/// documents (DOCX/PPTX and similar) via a LibreOffice text conversion.
pub fn extract_document_text(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();

    match extension.as_str() {
        "pdf" => extract_pdf_text(path),
        "docx" | "doc" | "pptx" | "ppt" | "odt" | "odp" | "rtf" => {
            extract_office_text(path, &extension)
        }
        _ => {
            fs::read_to_string(path).map_err(|_| {
                format!(
                "The file is not UTF-8 text and has no supported text extractor (extension '{}').",
                if extension.is_empty() { "none" } else { &extension }
            )
            })
        }
    }
}

fn read_pdf_data_url(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("Failed to read PDF bytes: {error}"))?;
    Ok(format!(
        "data:application/pdf;base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

fn convert_office_source_to_pdf_data_url(path: &Path, extension: &str) -> Result<String, String> {
    let pdf_path = convert_office_source_to_pdf(path, extension)?;
    let bytes = fs::read(&pdf_path)
        .map_err(|error| format!("Failed to read converted PDF bytes: {error}"))?;
    let _ = fs::remove_file(&pdf_path);
    Ok(format!(
        "data:application/pdf;base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

fn render_svg_data_url(
    file_name: &str,
    draft: &PageDraft,
    page_number: usize,
    total_pages: usize,
) -> String {
    let mut body = String::new();

    for (index, line) in draft.lines.iter().enumerate() {
        let y = 210 + (index * 28);
        body.push_str(&format!(
            "<text x=\"88\" y=\"{y}\" fill=\"#d9e3ea\" font-family=\"'IBM Plex Sans','Segoe UI',sans-serif\" font-size=\"24\">{}</text>",
            escape_xml(line)
        ));
    }

    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{SVG_WIDTH}\" height=\"{SVG_HEIGHT}\" viewBox=\"0 0 {SVG_WIDTH} {SVG_HEIGHT}\">\
          <defs>\
            <linearGradient id=\"bg\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\">\
              <stop offset=\"0%\" stop-color=\"#0f141a\"/>\
              <stop offset=\"100%\" stop-color=\"#15222c\"/>\
            </linearGradient>\
          </defs>\
          <rect width=\"100%\" height=\"100%\" rx=\"36\" fill=\"url(#bg)\"/>\
          <rect x=\"36\" y=\"36\" width=\"1128\" height=\"1528\" rx=\"28\" fill=\"rgba(255,255,255,0.03)\" stroke=\"rgba(150,190,210,0.3)\"/>\
          <text x=\"88\" y=\"110\" fill=\"#8be0c4\" font-family=\"'IBM Plex Mono','Consolas',monospace\" font-size=\"20\">{}</text>\
          <text x=\"88\" y=\"156\" fill=\"#ffffff\" font-family=\"'IBM Plex Sans','Segoe UI',sans-serif\" font-size=\"40\" font-weight=\"600\">{}</text>\
          <text x=\"1112\" y=\"110\" text-anchor=\"end\" fill=\"#9fb1bd\" font-family=\"'IBM Plex Mono','Consolas',monospace\" font-size=\"20\">{}/{}</text>\
          <line x1=\"88\" y1=\"176\" x2=\"1112\" y2=\"176\" stroke=\"rgba(255,255,255,0.14)\"/>\
          {}\
          <line x1=\"88\" y1=\"1496\" x2=\"1112\" y2=\"1496\" stroke=\"rgba(255,255,255,0.14)\"/>\
          <text x=\"88\" y=\"1540\" fill=\"#9fb1bd\" font-family=\"'IBM Plex Sans','Segoe UI',sans-serif\" font-size=\"20\">{}</text>\
        </svg>",
        escape_xml(&draft.label),
        escape_xml(file_name),
        page_number,
        total_pages,
        body,
        escape_xml(&draft.title),
    );

    let encoded = BASE64_STANDARD.encode(svg.as_bytes());
    format!("data:image/svg+xml;base64,{encoded}")
}

fn escape_xml(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use crate::text::{markdown_heading, wrap_text_block};

    #[test]
    fn markdown_heading_extracts_title() {
        assert_eq!(
            markdown_heading("## Preview Title"),
            Some("Preview Title".to_string())
        );
        assert_eq!(markdown_heading("plain text"), None);
    }

    #[test]
    fn wrap_text_block_preserves_breaks() {
        let wrapped = wrap_text_block("alpha beta gamma\n\ndelta");
        assert_eq!(
            wrapped,
            vec![
                "alpha beta gamma".to_string(),
                String::new(),
                "delta".to_string()
            ]
        );
    }
}
