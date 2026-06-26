use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const SVG_WIDTH: usize = 1200;
const SVG_HEIGHT: usize = 1600;
const MAX_CHARS_PER_LINE: usize = 78;
const MAX_LINES_PER_PAGE: usize = 42;

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
    "pdf" => Vec::new(),
    "docx" => Vec::new(),
    "pptx" => Vec::new(),
    _ => {
      return Err(format!(
        "Unsupported preview format '{extension}'. Supported formats: md, pdf, docx, pptx."
      ))
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

fn render_markdown(path: &Path) -> Result<Vec<PageDraft>, String> {
  let content = fs::read_to_string(path).map_err(|error| format!("Failed to read markdown file: {error}"))?;
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


fn read_pdf_data_url(path: &Path) -> Result<String, String> {
  let bytes = fs::read(path).map_err(|error| format!("Failed to read PDF bytes: {error}"))?;
  Ok(format!("data:application/pdf;base64,{}", BASE64_STANDARD.encode(bytes)))
}

fn convert_office_source_to_pdf_data_url(path: &Path, extension: &str) -> Result<String, String> {
  let pdf_path = convert_office_source_to_pdf(path, extension)?;
  let bytes = fs::read(&pdf_path).map_err(|error| format!("Failed to read converted PDF bytes: {error}"))?;
  let _ = fs::remove_file(&pdf_path);
  Ok(format!("data:application/pdf;base64,{}", BASE64_STANDARD.encode(bytes)))
}

fn convert_office_source_to_pdf(path: &Path, extension: &str) -> Result<std::path::PathBuf, String> {
  if let Some(soffice_path) = detect_soffice_path() {
    return convert_with_soffice(path, &soffice_path);
  }

  match extension {
    "docx" => convert_docx_with_word(path),
    "pptx" => convert_pptx_with_powerpoint(path),
    _ => Err(format!("Unsupported office conversion format: {extension}")),
  }
}

fn detect_soffice_path() -> Option<String> {
  let candidates = [
    "soffice",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  ];

  candidates
    .iter()
    .find(|candidate| {
      if candidate.contains('\\') {
        Path::new(candidate).exists()
      } else {
        Command::new(candidate)
          .arg("--version")
          .output()
          .map(|output| output.status.success())
          .unwrap_or(false)
      }
    })
    .map(|value| value.to_string())
}

fn convert_with_soffice(path: &Path, soffice_path: &str) -> Result<std::path::PathBuf, String> {
  let output_dir = unique_temp_preview_dir("soffice")?;
  let output = Command::new(soffice_path)
    .arg("--headless")
    .arg("--convert-to")
    .arg("pdf")
    .arg("--outdir")
    .arg(&output_dir)
    .arg(path)
    .output()
    .map_err(|error| format!("Failed to start LibreOffice conversion: {error}"))?;

  if !output.status.success() {
    return Err(format!(
      "LibreOffice conversion failed: {}",
      String::from_utf8_lossy(&output.stderr)
    ));
  }

  let pdf_path = output_dir.join(format!("{}.pdf", file_stem(path)));
  if !pdf_path.exists() {
    return Err("LibreOffice conversion did not produce a PDF output".to_string());
  }

  Ok(pdf_path)
}

fn convert_docx_with_word(path: &Path) -> Result<std::path::PathBuf, String> {
  let pdf_path = unique_temp_pdf_path(path)?;
  let script = format!(
    "$ErrorActionPreference = 'Stop'; \
     $word = New-Object -ComObject Word.Application; \
     $word.Visible = $false; \
     try {{ \
       $document = $word.Documents.Open('{}'); \
       $document.ExportAsFixedFormat('{}', 17); \
       $document.Close(); \
     }} finally {{ \
       $word.Quit(); \
     }}",
    escape_powershell_single_quoted(&path.display().to_string()),
    escape_powershell_single_quoted(&pdf_path.display().to_string()),
  );

  run_powershell_conversion(&script, &pdf_path, "Microsoft Word")
}

fn convert_pptx_with_powerpoint(path: &Path) -> Result<std::path::PathBuf, String> {
  let pdf_path = unique_temp_pdf_path(path)?;
  let script = format!(
    "$ErrorActionPreference = 'Stop'; \
     $powerpoint = New-Object -ComObject PowerPoint.Application; \
     try {{ \
       $presentation = $powerpoint.Presentations.Open('{}', $true, $false, $false); \
       $presentation.SaveAs('{}', 32); \
       $presentation.Close(); \
     }} finally {{ \
       $powerpoint.Quit(); \
     }}",
    escape_powershell_single_quoted(&path.display().to_string()),
    escape_powershell_single_quoted(&pdf_path.display().to_string()),
  );

  run_powershell_conversion(&script, &pdf_path, "Microsoft PowerPoint")
}

fn run_powershell_conversion(script: &str, expected_pdf_path: &Path, renderer_name: &str) -> Result<std::path::PathBuf, String> {
  let output = Command::new("powershell")
    .arg("-NoProfile")
    .arg("-NonInteractive")
    .arg("-Command")
    .arg(script)
    .output()
    .map_err(|error| format!("Failed to start {renderer_name} conversion: {error}"))?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    return Err(format!(
      "{renderer_name} conversion failed. Install LibreOffice or desktop Microsoft Office to get Office-aligned previews. stdout: {} stderr: {}",
      stdout.trim(),
      stderr.trim(),
    ));
  }

  if !expected_pdf_path.exists() {
    return Err(format!("{renderer_name} conversion completed without creating a PDF output"));
  }

  Ok(expected_pdf_path.to_path_buf())
}

fn unique_temp_preview_dir(prefix: &str) -> Result<std::path::PathBuf, String> {
  let dir = std::env::temp_dir().join(format!("lexilens-{prefix}-{}", unique_stamp()?));
  fs::create_dir_all(&dir).map_err(|error| format!("Failed to create temporary preview directory: {error}"))?;
  Ok(dir)
}

fn unique_temp_pdf_path(source_path: &Path) -> Result<std::path::PathBuf, String> {
  let dir = unique_temp_preview_dir("office")?;
  Ok(dir.join(format!("{}-{}.pdf", file_stem(source_path), unique_stamp()?)))
}

fn unique_stamp() -> Result<u128, String> {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .map_err(|error| format!("Failed to get system time: {error}"))
}

fn escape_powershell_single_quoted(value: &str) -> String {
  value.replace('\'', "''")
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
    return vec![placeholder_page(title.to_string(), label.to_string(), "No readable content on this page.".to_string())];
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

fn markdown_heading(line: &str) -> Option<String> {
  let trimmed = line.trim();
  let heading_level = trimmed.chars().take_while(|character| *character == '#').count();
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

fn wrap_text_block(text: &str) -> Vec<String> {
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

    let indent = paragraph.chars().take_while(|character| character.is_whitespace()).count();
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

fn render_svg_data_url(file_name: &str, draft: &PageDraft, page_number: usize, total_pages: usize) -> String {
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

fn file_stem(path: &Path) -> String {
  path
    .file_stem()
    .and_then(|value| value.to_str())
    .unwrap_or("document")
    .to_string()
}

#[cfg(test)]
mod tests {
  use super::{markdown_heading, wrap_text_block};

  #[test]
  fn markdown_heading_extracts_title() {
    assert_eq!(markdown_heading("## Preview Title"), Some("Preview Title".to_string()));
    assert_eq!(markdown_heading("plain text"), None);
  }

  #[test]
  fn wrap_text_block_preserves_breaks() {
    let wrapped = wrap_text_block("alpha beta gamma\n\ndelta");
    assert_eq!(wrapped, vec!["alpha beta gamma".to_string(), String::new(), "delta".to_string()]);
  }
}