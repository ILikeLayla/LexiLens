use crate::office::{detect_soffice_path, file_stem, unique_temp_preview_dir};
use crate::PageDraft;
use std::fs;
use std::path::Path;
use std::process::Command;

const MAX_CHARS_PER_LINE: usize = 78;
const MAX_LINES_PER_PAGE: usize = 42;

pub(crate) fn extract_pdf_text(path: &Path) -> Result<String, String> {
    pdf_extract::extract_text(path).map_err(|error| format!("Failed to extract PDF text: {error}"))
}

pub(crate) fn extract_office_text(path: &Path, extension: &str) -> Result<String, String> {
    let soffice_path = detect_soffice_path().ok_or_else(|| {
        format!(
            "Reading '{extension}' files as text requires LibreOffice (soffice) to be installed."
        )
    })?;

    let output_dir = unique_temp_preview_dir("soffice-txt")?;
    let output = Command::new(&soffice_path)
        .arg("--headless")
        .arg("--convert-to")
        .arg("txt:Text")
        .arg("--outdir")
        .arg(&output_dir)
        .arg(path)
        .output()
        .map_err(|error| format!("Failed to start LibreOffice text conversion: {error}"))?;

    if !output.status.success() {
        let _ = fs::remove_dir_all(&output_dir);
        return Err(format!(
            "LibreOffice text conversion failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let txt_path = output_dir.join(format!("{}.txt", file_stem(path)));
    let text = fs::read_to_string(&txt_path)
        .map_err(|error| format!("Failed to read converted text: {error}"));
    let _ = fs::remove_dir_all(&output_dir);
    text
}

pub(crate) fn render_markdown(path: &Path) -> Result<Vec<PageDraft>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read markdown file: {error}"))?;
    let fallback_title = file_stem(path);
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut current_title = fallback_title.clone();
    let mut current_lines: Vec<String> = Vec::new();

    for line in content.lines() {
        if let Some(title) = markdown_heading(line) {
            if !current_lines.is_empty() {
                sections.push((current_title.clone(), current_lines.join("\n")));
                current_lines.clear();
            }
            current_title = title;
            continue;
        }

        current_lines.push(line.to_string());
    }

    if !current_lines.is_empty() || sections.is_empty() {
        sections.push((current_title, current_lines.join("\n")));
    }

    Ok(expand_sections(sections, "Markdown"))
}

pub(crate) fn markdown_heading(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let heading_level = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if heading_level == 0 {
        return None;
    }

    let title = trimmed[heading_level..].trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

pub(crate) fn wrap_text_block(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n");
    let mut lines = Vec::new();

    for paragraph in normalized.split('\n') {
        let trimmed = paragraph.trim_end();
        if trimmed.is_empty() {
            if !lines.last().is_some_and(|line: &String| line.is_empty()) {
                lines.push(String::new());
            }
            continue;
        }

        let indent = paragraph
            .chars()
            .take_while(|character| character.is_whitespace())
            .count();
        let prefix = " ".repeat(indent.min(8));
        let available_width = MAX_CHARS_PER_LINE.saturating_sub(prefix.len()).max(20);
        let mut current = String::new();

        for word in trimmed.split_whitespace() {
            if current.is_empty() {
                current.push_str(word);
                continue;
            }

            if current.len() + 1 + word.len() > available_width {
                lines.push(format!("{prefix}{current}"));
                current.clear();
                current.push_str(word);
            } else {
                current.push(' ');
                current.push_str(word);
            }
        }

        if !current.is_empty() {
            lines.push(format!("{prefix}{current}"));
        }
    }

    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }

    lines
}

fn expand_sections(sections: Vec<(String, String)>, source_label: &str) -> Vec<PageDraft> {
    let mut drafts = Vec::new();
    for (index, (title, text)) in sections.into_iter().enumerate() {
        let label = format!("{source_label} section {}", index + 1);
        drafts.extend(slice_text_page(&title, &label, &text));
    }
    drafts
}

fn slice_text_page(title: &str, label: &str, text: &str) -> Vec<PageDraft> {
    let wrapped_lines = wrap_text_block(text);
    if wrapped_lines.is_empty() {
        return vec![placeholder_page(
            title.to_string(),
            label.to_string(),
            "No readable content on this page.".to_string(),
        )];
    }

    let mut drafts = Vec::new();
    for (chunk_index, chunk) in wrapped_lines.chunks(MAX_LINES_PER_PAGE).enumerate() {
        let chunk_label = if chunk_index == 0 {
            label.to_string()
        } else {
            format!("{label} (cont. {})", chunk_index + 1)
        };

        drafts.push(PageDraft {
            title: title.to_string(),
            label: chunk_label,
            lines: chunk.to_vec(),
        });
    }

    drafts
}

fn placeholder_page(title: String, label: String, message: String) -> PageDraft {
    PageDraft {
        title,
        label,
        lines: vec![message],
    }
}
