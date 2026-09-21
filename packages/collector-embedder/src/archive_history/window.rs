use std::fs::File;
use std::io::Read;
use std::path::Path;

pub const ARCHIVE_IDENTITY_PROBE_BYTES: usize = 1024 * 1024;
pub const ARCHIVE_BASELINE_PARTS_PER_CYCLE: usize = 128;
pub const ARCHIVE_BASELINE_READ_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;

/// Read only the bounded prefix needed to identify a transcript. An oversized or unfinished first
/// record is left unidentified for this pass. Capture owns the full byte stream and never extends
/// this probe to an attacker-controlled newline.
pub fn read_identity_window(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut bytes = vec![0; ARCHIVE_IDENTITY_PROBE_BYTES];
    let read = file.read(&mut bytes)?;
    bytes.truncate(read);
    let end = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    bytes.truncate(end);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn identity_window_is_bounded_when_the_first_record_is_oversized() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("oversized.jsonl");
        let mut file = br#"{"sessionId":"session","value":""#.to_vec();
        file.extend(std::iter::repeat_n(b'x', ARCHIVE_IDENTITY_PROBE_BYTES));
        file.extend_from_slice(b"\"}\n");
        fs::write(&path, file).unwrap();

        assert!(read_identity_window(&path).unwrap().is_empty());
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
