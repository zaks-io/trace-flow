use std::fs::File;
use std::io::Read;
use std::path::Path;

pub const ARCHIVE_COPY_COMPARE_CHUNK_BYTES: usize = 1024 * 1024;

use super::window::complete_extent;

pub fn prefix_compatible(shorter: &Path, longer: &Path) -> std::io::Result<bool> {
    let extent = complete_extent(shorter)?;
    let mut left = File::open(shorter)?;
    let mut right = File::open(longer)?;
    let mut compared = 0u64;
    let mut left_buf = vec![0u8; ARCHIVE_COPY_COMPARE_CHUNK_BYTES];
    let mut right_buf = vec![0u8; ARCHIVE_COPY_COMPARE_CHUNK_BYTES];
    while compared < extent {
        let wanted = ((extent - compared) as usize).min(ARCHIVE_COPY_COMPARE_CHUNK_BYTES);
        left.read_exact(&mut left_buf[..wanted])?;
        right.read_exact(&mut right_buf[..wanted])?;
        if left_buf[..wanted] != right_buf[..wanted] {
            return Ok(false);
        }
        compared += wanted as u64;
    }
    Ok(true)
}
