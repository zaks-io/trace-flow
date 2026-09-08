use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use collector_archive::complete_record_end_offsets;

pub const ARCHIVE_IDENTITY_PROBE_BYTES: usize = 256 * 1024;
pub const ARCHIVE_BASELINE_PARTS_PER_CYCLE: usize = 128;
pub const ARCHIVE_BASELINE_READ_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;

pub fn read_probe(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut bytes = vec![0; ARCHIVE_IDENTITY_PROBE_BYTES];
    let read = file.read(&mut bytes)?;
    bytes.truncate(read);
    truncate_partial_tail(&mut bytes);
    Ok(bytes)
}

pub fn complete_extent(path: &Path) -> std::io::Result<u64> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(0);
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    if last[0] == b'\n' {
        return Ok(len);
    }
    let mut end = len;
    let mut chunk = vec![0u8; 1024 * 1024];
    loop {
        let start = end.saturating_sub(chunk.len() as u64);
        let wanted = (end - start) as usize;
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut chunk[..wanted])?;
        if let Some(index) = chunk[..wanted].iter().rposition(|byte| *byte == b'\n') {
            let record_start = start + index as u64 + 1;
            let mut tail = vec![0u8; (len - record_start) as usize];
            file.seek(SeekFrom::Start(record_start))?;
            file.read_exact(&mut tail)?;
            return if serde_json::from_slice::<serde_json::Value>(&tail).is_ok() {
                Ok(len)
            } else {
                Ok(record_start)
            };
        }
        if start == 0 {
            let mut bytes = vec![0u8; len as usize];
            file.seek(SeekFrom::Start(0))?;
            file.read_exact(&mut bytes)?;
            return if serde_json::from_slice::<serde_json::Value>(&bytes).is_ok() {
                Ok(len)
            } else {
                Ok(0)
            };
        }
        end = start;
    }
}

fn truncate_partial_tail(bytes: &mut Vec<u8>) {
    let end = complete_record_end_offsets(bytes)
        .ok()
        .and_then(|ends| ends.last().copied())
        .unwrap_or(0);
    bytes.truncate(end);
}
