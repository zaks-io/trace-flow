use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use collector_archive::complete_record_end_offsets;

pub const ARCHIVE_CAPTURE_WINDOW_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) fn read_capture_window(
    path: &Path,
    prior_offset: u64,
    minimum_observed_size: u64,
) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let wanted = len.min(
        prior_offset
            .saturating_add(ARCHIVE_CAPTURE_WINDOW_BYTES)
            .max(minimum_observed_size),
    );
    let mut bytes = vec![0; wanted as usize];
    file.read_exact(&mut bytes)?;
    if wanted == len {
        return Ok(bytes);
    }

    let appended = &bytes[prior_offset.min(wanted) as usize..];
    if complete_record_end_offsets(appended).is_ok_and(|ends| !ends.is_empty()) {
        truncate_partial_tail_after(&mut bytes, prior_offset as usize);
        return Ok(bytes);
    }

    file.seek(SeekFrom::Start(wanted))?;
    let mut one = [0u8; 1];
    while file.read(&mut one)? == 1 {
        bytes.push(one[0]);
        if one[0] == b'\n' {
            break;
        }
    }
    Ok(bytes)
}

fn truncate_partial_tail_after(bytes: &mut Vec<u8>, start: usize) {
    let end = complete_record_end_offsets(&bytes[start..])
        .ok()
        .and_then(|ends| ends.last().copied())
        .map(|end| start + end)
        .unwrap_or(start);
    bytes.truncate(end);
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn a_record_larger_than_the_window_is_read_through_its_boundary() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("large.jsonl");
        let mut record = Vec::with_capacity(ARCHIVE_CAPTURE_WINDOW_BYTES as usize + 64);
        record.extend_from_slice(b"{\"value\":\"");
        record.extend(std::iter::repeat_n(
            b'x',
            ARCHIVE_CAPTURE_WINDOW_BYTES as usize,
        ));
        record.extend_from_slice(b"\"}\n{\"next\":true}\n");
        fs::write(&path, &record).unwrap();

        let window = read_capture_window(&path, 0, 0).unwrap();

        assert!(window.len() > ARCHIVE_CAPTURE_WINDOW_BYTES as usize);
        assert!(window.ends_with(b"}\n"));
        assert!(!window.ends_with(b"{\"next\":true}\n"));
    }

    #[test]
    fn an_eof_partial_record_remains_available_for_the_next_cycle() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("partial.jsonl");
        let first = b"{\"one\":true}\n{\"two\":";
        fs::write(&path, first).unwrap();
        let window = read_capture_window(&path, 0, 0).unwrap();
        assert_eq!(window, first);

        fs::write(&path, b"{\"one\":true}\n{\"two\":true}\n").unwrap();
        let next = read_capture_window(&path, b"{\"one\":true}\n".len() as u64, first.len() as u64)
            .unwrap();
        assert!(next.ends_with(b"{\"two\":true}\n"));
    }
}
