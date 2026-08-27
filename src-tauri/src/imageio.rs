//! Encoding, metadata stripping, disk writes and clipboard.
//!
//! Two hard rules live here:
//!
//! 1. **Metadata never survives.** Everything is decoded to raw pixels and
//!    re-encoded from scratch. The `image` crate writes no EXIF, XMP, IPTC, ICC
//!    or text chunks, so a decode -> encode round trip is a total strip --
//!    including the EXIF *thumbnail*, which is the classic leak (the embedded
//!    preview stays un-redacted while the main image is edited).
//!
//! 2. **Files are written whole, never patched.** CVE-2023-28303 ("acropalypse")
//!    happened because Windows Snipping Tool reopened an existing file and wrote
//!    a shorter image into it without truncating, leaving the original tail
//!    recoverable. We always write a fresh temp file and rename it into place, so
//!    a target file is replaced atomically and no old bytes can survive.

use anyhow::{anyhow, Context, Result};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::{ImageEncoder, RgbaImage};
use std::borrow::Cow;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

/// Decode arbitrary image bytes into raw pixels, discarding every non-pixel
/// container field in the process.
pub fn decode_to_pixels(bytes: &[u8]) -> Result<RgbaImage> {
    let img = image::load_from_memory(bytes).context("decode image")?;
    Ok(img.to_rgba8())
}

/// Re-encode to PNG with no ancillary chunks (no tEXt/iTXt/zTXt, no tIME, no iCCP).
pub fn encode_png(img: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Default, PngFilter::Adaptive)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgba8,
        )
        .context("encode png")?;
    Ok(out)
}

/// Re-encode to JPEG. Alpha is flattened onto white first, since JPEG has no
/// alpha channel and a naive drop would turn transparent pixels black.
pub fn encode_jpeg(img: &RgbaImage, quality: u8) -> Result<Vec<u8>> {
    let mut rgb = image::RgbImage::new(img.width(), img.height());
    for (x, y, px) in img.enumerate_pixels() {
        let [r, g, b, a] = px.0;
        let a = a as u32;
        let blend = |c: u8| (((c as u32 * a) + 255 * (255 - a)) / 255) as u8;
        rgb.put_pixel(x, y, image::Rgb([blend(r), blend(g), blend(b)]));
    }
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100))
        .encode_image(&image::DynamicImage::ImageRgb8(rgb))
        .context("encode jpeg")?;
    Ok(out)
}

/// Encode according to the target path's extension. Unknown extensions get PNG.
pub fn encode_for_path(img: &RgbaImage, path: &Path, jpeg_quality: u8) -> Result<Vec<u8>> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => encode_jpeg(img, jpeg_quality),
        _ => encode_png(img),
    }
}

/// Write bytes to `path` atomically: fresh temp file in the same directory,
/// fsync, then rename over the target. Never reopens or partially patches an
/// existing file (see the acropalypse note at the top of this module).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&dir).with_context(|| format!("create dir {}", dir.display()))?;

    let stem = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("voidshot.png");
    let tmp = dir.join(format!(".{stem}.{}.tmp", std::process::id()));

    {
        let file = fs::File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        let mut writer = BufWriter::new(file);
        writer.write_all(bytes).context("write image bytes")?;
        writer.flush().context("flush image bytes")?;
        writer
            .into_inner()
            .map_err(|e| anyhow!("flush temp file: {e}"))?
            .sync_all()
            .context("fsync temp file")?;
    }

    // On Windows rename fails if the destination exists, so clear it first.
    #[cfg(windows)]
    if path.exists() {
        let _ = fs::remove_file(path);
    }

    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        anyhow!("rename {} -> {}: {e}", tmp.display(), path.display())
    })?;

    Ok(())
}

/// Put raw pixels on the system clipboard as an image.
pub fn copy_image_to_clipboard(img: &RgbaImage) -> Result<()> {
    let mut clipboard = arboard::Clipboard::new().context("open clipboard")?;
    clipboard
        .set_image(arboard::ImageData {
            width: img.width() as usize,
            height: img.height() as usize,
            bytes: Cow::Borrowed(img.as_raw()),
        })
        .context("set clipboard image")?;
    Ok(())
}

/// `Voidshot_2026-08-15_17-30-12.png` — sortable, no spaces, no user data.
pub fn default_filename(ext: &str) -> String {
    let now = chrono::Local::now();
    format!("Voidshot_{}.{ext}", now.format("%Y-%m-%d_%H-%M-%S"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn sample() -> RgbaImage {
        let mut img = RgbaImage::new(64, 48);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = Rgba([(x * 4) as u8, (y * 5) as u8, 128, 255]);
        }
        img
    }

    /// Walk PNG chunk types so we can assert on exactly what got written.
    fn png_chunks(bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        let mut i = 8; // skip signature
        while i + 8 <= bytes.len() {
            let len = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
            let kind = String::from_utf8_lossy(&bytes[i + 4..i + 8]).to_string();
            out.push(kind);
            i += 12 + len as usize; // len + type + data + crc
        }
        out
    }

    #[test]
    fn png_carries_no_metadata_chunks() {
        let png = encode_png(&sample()).unwrap();
        let chunks = png_chunks(&png);

        // Anything that can carry text, timestamps, colour profiles or an
        // embedded preview must be absent.
        for bad in ["tEXt", "iTXt", "zTXt", "eXIf", "iCCP", "tIME", "pHYs"] {
            assert!(
                !chunks.iter().any(|c| c == bad),
                "PNG contains {bad} chunk: {chunks:?}"
            );
        }
        assert!(chunks.iter().any(|c| c == "IHDR"));
        assert!(chunks.iter().any(|c| c == "IDAT"));
    }

    #[test]
    fn jpeg_exif_is_stripped_by_round_trip() {
        let clean = encode_jpeg(&sample(), 90).unwrap();

        // Splice a fake APP1/Exif segment in after SOI, the way a camera or
        // phone would. This is also where an un-redacted EXIF thumbnail lives.
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&[0x49, 0x49, 0x2a, 0x00]); // little-endian TIFF header
        payload.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        let seg_len = (payload.len() + 2) as u16;

        let mut tainted = vec![0xFF, 0xD8];
        tainted.extend_from_slice(&[0xFF, 0xE1]);
        tainted.extend_from_slice(&seg_len.to_be_bytes());
        tainted.extend_from_slice(&payload);
        tainted.extend_from_slice(&clean[2..]);

        assert!(
            tainted.windows(4).any(|w| w == b"Exif"),
            "test fixture should contain EXIF"
        );

        let pixels = decode_to_pixels(&tainted).unwrap();
        let out = encode_jpeg(&pixels, 90).unwrap();

        assert!(
            !out.windows(4).any(|w| w == b"Exif"),
            "EXIF survived the re-encode"
        );
        assert!(
            !out.windows(4).any(|w| w == [0xde, 0xad, 0xbe, 0xef]),
            "EXIF payload survived the re-encode"
        );
    }

    /// Regression guard for the acropalypse class of bug (CVE-2023-28303):
    /// writing a smaller image over a larger file must not leave the old tail
    /// behind.
    #[test]
    fn write_atomic_leaves_no_tail_from_a_larger_previous_file() {
        let dir = std::env::temp_dir().join(format!("voidshot-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("shot.png");

        let big = vec![0xAAu8; 40_000];
        write_atomic(&path, &big).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), 40_000);

        let small = vec![0x55u8; 900];
        write_atomic(&path, &small).unwrap();

        let read_back = fs::read(&path).unwrap();
        assert_eq!(read_back.len(), 900, "old bytes remained past the new end");
        assert!(
            !read_back.contains(&0xAA),
            "bytes from the previous file survived"
        );

        // And no temp files left lying around with sensitive pixels in them.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn jpeg_flattens_alpha_onto_white_not_black() {
        let mut img = RgbaImage::new(8, 8);
        for px in img.pixels_mut() {
            *px = Rgba([255, 0, 0, 0]); // fully transparent red
        }
        let jpeg = encode_jpeg(&img, 95).unwrap();
        let back = decode_to_pixels(&jpeg).unwrap();
        let px = back.get_pixel(4, 4).0;
        assert!(
            px[0] > 240 && px[1] > 240 && px[2] > 240,
            "transparent pixels should flatten to white, got {px:?}"
        );
    }
}
