//! Text recognition.
//!
//! Windows: uses `Windows.Media.Ocr`, which ships with Windows 10/11. It is
//! fully offline and adds nothing to the bundle size -- unlike Tesseract, which
//! would drag in ~30 MB of language data per language.
//!
//! Elsewhere: shells out to the `tesseract` binary if the user has one.

use anyhow::Result;
use image::RgbaImage;

/// OCR accuracy falls off a cliff on small text, so upscale anything tiny.
/// Nearest-neighbour on purpose: it keeps glyph edges crisp instead of smearing
/// them, which the recognizer prefers.
fn prepare(img: &RgbaImage) -> RgbaImage {
    let (w, h) = (img.width(), img.height());
    let factor = if w < 200 || h < 60 {
        4
    } else if w < 600 || h < 200 {
        2
    } else {
        1
    };
    if factor == 1 {
        return img.clone();
    }
    image::imageops::resize(
        img,
        w * factor,
        h * factor,
        image::imageops::FilterType::Nearest,
    )
}

#[cfg(windows)]
pub fn recognize(img: &RgbaImage) -> Result<String> {
    use anyhow::anyhow;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;

    let img = prepare(img);
    let (w, h) = (img.width(), img.height());

    // Windows.Media.Ocr refuses images outside this range.
    if w < 40 || h < 40 {
        return Err(anyhow!("selection too small for OCR (min 40x40 px)"));
    }
    if w > 10000 || h > 10000 {
        return Err(anyhow!("selection too large for OCR (max 10000 px per side)"));
    }

    // SoftwareBitmap wants BGRA8; `image` gives us RGBA8.
    let mut bgra = Vec::with_capacity((w * h * 4) as usize);
    for px in img.pixels() {
        let [r, g, b, a] = px.0;
        bgra.extend_from_slice(&[b, g, r, a]);
    }

    // DataWriter -> DetachBuffer is the clean way to get an IBuffer without
    // dropping down to the IBufferByteAccess COM interface.
    let writer = DataWriter::new().map_err(|e| anyhow!("DataWriter: {e}"))?;
    writer
        .WriteBytes(&bgra)
        .map_err(|e| anyhow!("write pixels: {e}"))?;
    let buffer = writer
        .DetachBuffer()
        .map_err(|e| anyhow!("detach buffer: {e}"))?;

    let bitmap =
        SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w as i32, h as i32)
            .map_err(|e| anyhow!("SoftwareBitmap: {e}"))?;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| anyhow!("no OCR language installed: {e}"))?;

    // `join()` blocks until the async operation completes (this used to be
    // `get()` in windows-rs before 0.6x).
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| anyhow!("recognize: {e}"))?
        .join()
        .map_err(|e| anyhow!("recognize await: {e}"))?;

    let text = result
        .Text()
        .map_err(|e| anyhow!("read text: {e}"))?
        .to_string();

    Ok(text)
}

#[cfg(not(windows))]
pub fn recognize(img: &RgbaImage) -> Result<String> {
    use anyhow::{anyhow, Context};
    use std::process::Command;

    let img = prepare(img);
    let png = crate::imageio::encode_png(&img)?;

    let dir = std::env::temp_dir();
    let input = dir.join(format!("voidshot-ocr-{}.png", std::process::id()));
    crate::imageio::write_atomic(&input, &png)?;

    let run = Command::new("tesseract")
        .arg(&input)
        .arg("stdout")
        .output()
        .context("tesseract not found -- install it or use the Windows build");

    // The OCR input is a copy of possibly sensitive pixels; remove it whatever
    // happened above.
    let _ = std::fs::remove_file(&input);

    let out = run?;
    if !out.status.success() {
        return Err(anyhow!(
            "tesseract failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
