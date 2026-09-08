use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use collector_archive::complete_record_end_offsets;
use serde::de::IgnoredAny;
use serde::Deserialize;

pub const ARCHIVE_IDENTITY_PROBE_BYTES: usize = 256 * 1024;
pub const ARCHIVE_BASELINE_PARTS_PER_CYCLE: usize = 128;
pub const ARCHIVE_BASELINE_READ_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;

pub fn read_identity_window(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut bytes = vec![0; ARCHIVE_IDENTITY_PROBE_BYTES];
    let read = file.read(&mut bytes)?;
    bytes.truncate(read);
    if bytes.contains(&b'\n') || read < ARCHIVE_IDENTITY_PROBE_BYTES {
        truncate_partial_tail(&mut bytes);
        return Ok(bytes);
    }

    let mut chunk = vec![0; 64 * 1024];
    loop {
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        if let Some(index) = chunk[..read].iter().position(|byte| *byte == b'\n') {
            bytes.extend_from_slice(&chunk[..=index]);
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
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
            return if is_complete_json(path, record_start)? {
                Ok(len)
            } else {
                Ok(record_start)
            };
        }
        if start == 0 {
            return if is_complete_json(path, 0)? {
                Ok(len)
            } else {
                Ok(0)
            };
        }
        end = start;
    }
}

fn is_complete_json(path: &Path, start: u64) -> std::io::Result<bool> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(file));
    let result = IgnoredAny::deserialize(&mut deserializer).and_then(|_| deserializer.end());
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.is_io() => Err(std::io::Error::new(
            error.io_error_kind().unwrap_or(std::io::ErrorKind::Other),
            "failed to read archive history record",
        )),
        Err(_) => Ok(false),
    }
}

fn truncate_partial_tail(bytes: &mut Vec<u8>) {
    let end = complete_record_end_offsets(bytes)
        .ok()
        .and_then(|ends| ends.last().copied())
        .unwrap_or(0);
    bytes.truncate(end);
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn identity_window_reads_one_oversized_first_record() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("oversized.jsonl");
        let mut first = br#"{"sessionId":"session","value":""#.to_vec();
        first.extend(std::iter::repeat_n(b'x', ARCHIVE_IDENTITY_PROBE_BYTES));
        first.extend_from_slice(b"\"}\n");
        let mut file = first.clone();
        file.extend_from_slice(b"{\"next\":true}\n");
        fs::write(&path, file).unwrap();

        assert_eq!(read_identity_window(&path).unwrap(), first);
    }

    #[test]
    fn identity_window_does_not_retain_a_large_later_record() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("unknown-timestamp.jsonl");
        let first = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"session\"}}\n";
        let mut file = first.to_vec();
        file.extend(std::iter::repeat_n(b'x', ARCHIVE_IDENTITY_PROBE_BYTES * 2));
        fs::write(&path, file).unwrap();

        assert_eq!(read_identity_window(&path).unwrap(), first);
    }
}
