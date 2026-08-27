//! Screen capture.
//!
//! Privacy rule for this module: the captured frame NEVER touches disk. It lives
//! in memory, gets handed to the editor, and is dropped when the overlay closes.

use anyhow::{anyhow, Result};
use image::{imageops::FilterType, RgbaImage};
use serde::Serialize;
use xcap::Monitor;

/// Geometry of the stitched virtual desktop.
///
/// `x`/`y`/`width`/`height` are in *logical* units (what the window manager uses
/// to position windows). `pixel_width`/`pixel_height` are the real pixel
/// dimensions of the stitched image. `scale` maps one to the other.
/// One monitor's rect expressed in canvas pixels (origin at the canvas's
/// top-left), so the editor can snap a selection to a single screen.
#[derive(Serialize, Clone, Copy, Debug)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct DesktopGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub scale: f64,
    pub monitors: Vec<MonitorRect>,
}

pub struct Frame {
    pub geometry: DesktopGeometry,
    pub pixels: RgbaImage,
}

struct Panel {
    /// logical rect on the virtual desktop
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    image: RgbaImage,
}

/// Grab every monitor and stitch them into one image covering the whole
/// virtual desktop.
///
/// Mixed-DPI handling: each monitor reports a logical rect, but `capture_image`
/// returns *physical* pixels. We build the canvas at the highest scale factor in
/// play and resample any monitor that does not natively match it, so a 150%
/// laptop panel next to a 100% external monitor lines up instead of drifting.
pub fn capture_desktop() -> Result<Frame> {
    let monitors = Monitor::all().map_err(|e| anyhow!("enumerate monitors: {e}"))?;
    if monitors.is_empty() {
        return Err(anyhow!("no monitors found"));
    }

    let mut panels: Vec<Panel> = Vec::with_capacity(monitors.len());
    let mut scale: f64 = 1.0;

    for m in monitors {
        let image = m
            .capture_image()
            .map_err(|e| anyhow!("capture monitor: {e}"))?;
        let sf = m.scale_factor().unwrap_or(1.0) as f64;
        let sf = if sf.is_finite() && sf > 0.0 { sf } else { 1.0 };
        scale = scale.max(sf);

        // Derive the logical size from the captured bitmap rather than trusting
        // the reported width/height: on Windows those are logical, on some X11
        // setups they are physical, and the bitmap is the one thing that is
        // unambiguously physical.
        let logical_w = (image.width() as f64 / sf).round().max(1.0) as u32;
        let logical_h = (image.height() as f64 / sf).round().max(1.0) as u32;

        panels.push(Panel {
            x: m.x().unwrap_or(0),
            y: m.y().unwrap_or(0),
            w: logical_w,
            h: logical_h,
            image,
        });
    }

    let min_x = panels.iter().map(|p| p.x).min().unwrap();
    let min_y = panels.iter().map(|p| p.y).min().unwrap();
    let max_x = panels.iter().map(|p| p.x + p.w as i32).max().unwrap();
    let max_y = panels.iter().map(|p| p.y + p.h as i32).max().unwrap();

    let logical_w = (max_x - min_x).max(1) as u32;
    let logical_h = (max_y - min_y).max(1) as u32;
    let pixel_w = (logical_w as f64 * scale).round() as u32;
    let pixel_h = (logical_h as f64 * scale).round() as u32;

    let mut canvas = RgbaImage::new(pixel_w, pixel_h);

    for panel in panels {
        // Where this panel lands on the stitched canvas, in canvas pixels.
        let dst_x = (((panel.x - min_x) as f64) * scale).round() as i64;
        let dst_y = (((panel.y - min_y) as f64) * scale).round() as i64;
        let dst_w = ((panel.w as f64) * scale).round().max(1.0) as u32;
        let dst_h = ((panel.h as f64) * scale).round().max(1.0) as u32;

        let src = if panel.image.width() == dst_w && panel.image.height() == dst_h {
            panel.image
        } else {
            image::imageops::resize(&panel.image, dst_w, dst_h, FilterType::Triangle)
        };

        image::imageops::replace(&mut canvas, &src, dst_x, dst_y);
    }

    Ok(Frame {
        geometry: DesktopGeometry {
            x: min_x,
            y: min_y,
            width: logical_w,
            height: logical_h,
            pixel_width: pixel_w,
            pixel_height: pixel_h,
            scale,
            // Filled in by the caller from the window manager's own monitor
            // list, which is authoritative for where the overlay actually sits.
            monitors: Vec::new(),
        },
        pixels: canvas,
    })
}
