// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. Trace Flow owns the contract, IDs, pricing, redaction, and storage around
// this code.

//! Plain and zstd-compressed transcript files.
//!
//! Codex CLI compresses an idle rollout to `<name>.jsonl.zst` and removes `<name>.jsonl`, roughly a
//! week after its last write. The compressed file is usually the same transcript, so discovery,
//! change detection, assembly, and lineage read its decompressed text. Codex instead collapses some
//! subagent and guardian-review rollouts as it compresses them, which sync recognizes and skips (see
//! `TranscriptSnapshot::is_collapsed_codex_archive`). A compressed file's cursor still
//! records its on-disk size and mtime, because those are what the next scan stats. Rollouts keep
//! their mtime through compression, so an idle rollout stays outside the incremental window, and
//! history imports and replays read it like any other file.
//!
//! A plain file's size bounds what reading it costs; a compressed one's on-disk size does not. The
//! root `--system` collector reads other users' agent homes, so a few-KB zstd bomb there could exhaust
//! it. A compressed read therefore stops with an error once its output passes
//! [`MAX_DECOMPRESSED_BYTES`], and a first frame that declares more is refused before decoding.
//! Undeclared sizes and multi-frame files are valid zstd and read normally under that cap, so they
//! cannot fail every pass and hold the sync window open. Parsing still expands text into records;
//! the cap puts a compressed file on the footing of a plain file of the same decompressed size.

use std::cell::Cell;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;
use std::rc::Rc;

use crate::discovery::DiscoveredFile;

const PLAIN_SUFFIX: &str = ".jsonl";
const COMPRESSED_SUFFIX: &str = ".jsonl.zst";
/// `ZSTD_FRAMEHEADERSIZE_MAX`: enough bytes to read any frame's declared content size.
const FRAME_HEADER_MAX_BYTES: u64 = 18;
/// About four times the largest Codex rollout seen decompressed (497 MB).
const MAX_DECOMPRESSED_BYTES: u64 = 2 << 30;

pub(crate) fn is_transcript_name(name: &str) -> bool {
    name.ends_with(PLAIN_SUFFIX) || name.ends_with(COMPRESSED_SUFFIX)
}

pub(crate) fn is_compressed(path: &str) -> bool {
    path.ends_with(COMPRESSED_SUFFIX)
}

/// The path a transcript was first read under: a compressed file's plain path, otherwise `path`.
/// Session git pins and parser-version cursors written before Codex compressed the file are keyed
/// by it, and the compressed file is the same transcript.
pub fn uncompressed_path(path: &str) -> &str {
    plain_path(path).unwrap_or(path)
}

/// The plain transcript path a compressed file was made from.
pub(crate) fn plain_path(compressed: &str) -> Option<&str> {
    compressed
        .strip_suffix(COMPRESSED_SUFFIX)
        .map(|stem| &compressed[..stem.len() + PLAIN_SUFFIX.len()])
}

/// The file name without its transcript suffix, which Codex rollouts end with their session id.
pub(crate) fn transcript_stem(path: &str) -> Option<&str> {
    let name = Path::new(path).file_name()?.to_str()?;
    name.strip_suffix(COMPRESSED_SUFFIX)
        .or_else(|| name.strip_suffix(PLAIN_SUFFIX))
        .or_else(|| Path::new(name).file_stem()?.to_str())
}

/// Open `path` as decompressed transcript text.
pub(crate) fn open_text(path: &str) -> io::Result<Box<dyn BufRead>> {
    let file = File::open(path)?;
    if is_compressed(path) {
        decompressed(path, file, MAX_DECOMPRESSED_BYTES)
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

/// Decode `input`, the compressed file at `path`, to at most `limit` bytes; see the module docs.
fn decompressed<R: Read + 'static>(
    path: &str,
    input: R,
    limit: u64,
) -> io::Result<Box<dyn BufRead>> {
    if let Some(declared) = declared_content_size(path).filter(|declared| *declared > limit) {
        return Err(invalid_data(format!(
            "compressed transcript declares {declared} bytes, over the {limit}-byte limit"
        )));
    }
    Ok(Box::new(BufReader::new(OutputLimit {
        inner: zstd::stream::read::Decoder::new(input)?,
        remaining: limit,
    })))
}

/// A transcript's text bounded to its discovered on-disk size. [`BoundedText::consumed`] reports the
/// on-disk bytes read so far, which callers compare with the discovered size to reject a file that
/// shrank.
pub(crate) struct BoundedText {
    pub(crate) text: Box<dyn BufRead>,
    consumed: Rc<Cell<u64>>,
}

impl BoundedText {
    pub(crate) fn open(file: &DiscoveredFile) -> io::Result<Self> {
        let consumed = Rc::new(Cell::new(0));
        let input = CountingReader {
            inner: File::open(&file.path)?.take(file.size_bytes),
            consumed: Rc::clone(&consumed),
        };
        let text: Box<dyn BufRead> = if is_compressed(&file.path) {
            decompressed(&file.path, input, MAX_DECOMPRESSED_BYTES)?
        } else {
            Box::new(BufReader::new(input))
        };
        Ok(Self { text, consumed })
    }

    pub(crate) fn consumed(&self) -> u64 {
        self.consumed.get()
    }
}

/// Bytes a transcript occupies once read, for bounding how many files assemble together. A
/// compressed file reports the content size its zstd frame declares. One that declares none, or
/// cannot be probed, reports `u64::MAX` so it is batched alone.
pub fn resident_bytes(file: &DiscoveredFile) -> u64 {
    if !is_compressed(&file.path) {
        return file.size_bytes;
    }
    declared_content_size(&file.path).unwrap_or(u64::MAX)
}

fn declared_content_size(path: &str) -> Option<u64> {
    let mut header = Vec::with_capacity(FRAME_HEADER_MAX_BYTES as usize);
    File::open(path)
        .ok()?
        .take(FRAME_HEADER_MAX_BYTES)
        .read_to_end(&mut header)
        .ok()?;
    zstd::zstd_safe::get_frame_content_size(&header)
        .ok()
        .flatten()
}

/// Fails once `inner` yields more than `remaining` bytes, instead of decoding without bound.
struct OutputLimit<R> {
    inner: R,
    remaining: u64,
}

impl<R: Read> Read for OutputLimit<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // Ask for one byte past the limit, so an overrun surfaces instead of truncating.
        let want = usize::try_from(self.remaining.saturating_add(1)).unwrap_or(usize::MAX);
        let len = buf.len().min(want);
        let n = self.inner.read(&mut buf[..len])?;
        self.remaining = self.remaining.checked_sub(n as u64).ok_or_else(|| {
            invalid_data("compressed transcript decodes past the size limit".to_string())
        })?;
        Ok(n)
    }
}

fn invalid_data(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

struct CountingReader<R> {
    inner: R,
    consumed: Rc<Cell<u64>>,
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.consumed.set(self.consumed.get() + n as u64);
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn discovered(path: &Path) -> DiscoveredFile {
        DiscoveredFile {
            path: path.to_str().unwrap().to_string(),
            mtime_ms: 0.0,
            size_bytes: std::fs::metadata(path).unwrap().len(),
        }
    }

    #[test]
    fn names_and_stems_cover_both_forms() {
        assert!(is_transcript_name("a.jsonl"));
        assert!(is_transcript_name("a.jsonl.zst"));
        assert!(!is_transcript_name("a.zst"));
        assert!(!is_transcript_name("a.jsonl.bak"));
        assert_eq!(plain_path("/s/a.jsonl.zst"), Some("/s/a.jsonl"));
        assert_eq!(plain_path("/s/a.jsonl"), None);
        assert_eq!(uncompressed_path("/s/a.jsonl.zst"), "/s/a.jsonl");
        assert_eq!(uncompressed_path("/s/a.jsonl"), "/s/a.jsonl");
        assert_eq!(transcript_stem("/s/rollout-x.jsonl.zst"), Some("rollout-x"));
        assert_eq!(transcript_stem("/s/rollout-x.jsonl"), Some("rollout-x"));
    }

    fn write_compressed(dir: &Path, name: &str, frames: &[&[u8]]) -> String {
        let path = dir.join(name);
        let bytes: Vec<u8> = frames
            .iter()
            .flat_map(|text| zstd::bulk::compress(text, 3).unwrap())
            .collect();
        std::fs::write(&path, bytes).unwrap();
        path.to_str().unwrap().to_string()
    }

    fn read_all(mut text: Box<dyn BufRead>) -> io::Result<Vec<u8>> {
        let mut out = Vec::new();
        text.read_to_end(&mut out).map(|_| out)
    }

    #[test]
    fn compressed_reads_cover_every_frame_and_stop_at_the_limit() {
        let dir = tempfile::TempDir::new().unwrap();
        let one = write_compressed(dir.path(), "one.jsonl.zst", &[b"{\"a\":1}\n"]);
        assert_eq!(read_all(open_text(&one).unwrap()).unwrap(), b"{\"a\":1}\n");

        let two = write_compressed(dir.path(), "two.jsonl.zst", &[b"{}\n", b"{\"b\":2}\n"]);
        assert_eq!(
            read_all(open_text(&two).unwrap()).unwrap(),
            b"{}\n{\"b\":2}\n"
        );
        let bounded = BoundedText::open(&discovered(Path::new(&two))).unwrap();
        assert_eq!(read_all(bounded.text).unwrap(), b"{}\n{\"b\":2}\n");
        // Later frames count toward the limit too.
        let capped = decompressed(&two, File::open(&two).unwrap(), 4).unwrap();
        assert_eq!(
            read_all(capped).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        let big = write_compressed(dir.path(), "big.jsonl.zst", &[&[b'\n'; 64]]);
        let over = decompressed(&big, File::open(&big).unwrap(), 63)
            .err()
            .unwrap();
        assert_eq!(over.kind(), io::ErrorKind::InvalidData);
        assert!(decompressed(&big, File::open(&big).unwrap(), 64).is_ok());
    }

    #[test]
    fn a_compressed_transcript_without_a_declared_size_reads_up_to_the_limit() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("undeclared.jsonl.zst");
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
        std::io::Write::write_all(&mut encoder, b"{}\n").unwrap();
        std::fs::write(&path, encoder.finish().unwrap()).unwrap();
        let path = path.to_str().unwrap();
        assert_eq!(read_all(open_text(path).unwrap()).unwrap(), b"{}\n");
        let bounded = BoundedText::open(&discovered(Path::new(path))).unwrap();
        assert_eq!(read_all(bounded.text).unwrap(), b"{}\n");

        let capped = decompressed(path, File::open(path).unwrap(), 2).unwrap();
        assert_eq!(
            read_all(capped).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn output_limit_allows_exactly_the_limit() {
        let read = |bytes: &[u8], remaining| {
            let mut out = Vec::new();
            OutputLimit {
                inner: bytes,
                remaining,
            }
            .read_to_end(&mut out)
            .map(|_| out)
        };
        assert_eq!(read(b"abc", 3).unwrap(), b"abc");
        assert_eq!(
            read(b"abcd", 3).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn resident_bytes_uses_the_declared_size_or_isolates_an_undeclared_one() {
        let dir = tempfile::TempDir::new().unwrap();
        let text = vec![b'\n'; 64 * 1024];

        let declared = dir.path().join("declared.jsonl.zst");
        std::fs::write(&declared, zstd::bulk::compress(&text, 3).unwrap()).unwrap();
        let declared = discovered(&declared);
        assert!(declared.size_bytes < text.len() as u64);
        assert_eq!(resident_bytes(&declared), text.len() as u64);

        // A streaming encoder that never learns the input size writes no content size.
        let undeclared = dir.path().join("undeclared.jsonl.zst");
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
        std::io::Write::write_all(&mut encoder, &text).unwrap();
        std::fs::write(&undeclared, encoder.finish().unwrap()).unwrap();
        assert_eq!(resident_bytes(&discovered(&undeclared)), u64::MAX);

        let plain = dir.path().join("plain.jsonl");
        std::fs::write(&plain, &text).unwrap();
        assert_eq!(resident_bytes(&discovered(&plain)), text.len() as u64);
    }
}
