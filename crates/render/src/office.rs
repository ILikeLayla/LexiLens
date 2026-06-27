use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn detect_soffice_path() -> Option<String> {
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

pub(crate) fn convert_office_source_to_pdf(
    path: &Path,
    extension: &str,
) -> Result<PathBuf, String> {
    if let Some(soffice_path) = detect_soffice_path() {
        return convert_with_soffice(path, &soffice_path);
    }

    match extension {
        "docx" => convert_docx_with_word(path),
        "pptx" => convert_pptx_with_powerpoint(path),
        _ => Err(format!("Unsupported office conversion format: {extension}")),
    }
}

pub(crate) fn unique_temp_preview_dir(prefix: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("lexilens-{prefix}-{}", unique_stamp()?));
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create temporary preview directory: {error}"))?;
    Ok(dir)
}

pub(crate) fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document")
        .to_string()
}

fn convert_with_soffice(path: &Path, soffice_path: &str) -> Result<PathBuf, String> {
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

fn convert_docx_with_word(path: &Path) -> Result<PathBuf, String> {
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

fn convert_pptx_with_powerpoint(path: &Path) -> Result<PathBuf, String> {
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

fn run_powershell_conversion(
    script: &str,
    expected_pdf_path: &Path,
    renderer_name: &str,
) -> Result<PathBuf, String> {
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
        return Err(format!(
            "{renderer_name} conversion completed without creating a PDF output"
        ));
    }

    Ok(expected_pdf_path.to_path_buf())
}

fn unique_temp_pdf_path(source_path: &Path) -> Result<PathBuf, String> {
    let dir = unique_temp_preview_dir("office")?;
    Ok(dir.join(format!(
        "{}-{}.pdf",
        file_stem(source_path),
        unique_stamp()?
    )))
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
