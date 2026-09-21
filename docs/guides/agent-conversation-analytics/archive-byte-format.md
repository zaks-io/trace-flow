# Archive byte format

Format 1 remains the existing JSONL record archive. Format 2 stores exact source
bytes as bounded segments, including separators, malformed records and unfinished
UTF-8. Readers must support both. Existing objects are never rewritten.

The existing upload, encryption, chain and commit journal are shared. A format 2
observation has `archive_format_version: 2`. Its payload contains at most 512 KiB
of original bytes using the existing canonical UTF-8/base64 encoding. Its
`source_record_identity` is `bytes:<start>:<end>`, where offsets are unsigned
decimal byte positions without leading zeroes and end is exclusive. A successor
generation appends `:from:<predecessor-part-id>` to each segment identity. The
manifest exposes this authenticated relationship as `predecessor_part_id`. This identity,
payload hash and part identity are authenticated by the existing chain hash.
Each local spool persists an encrypted random capture-instance identifier. The first byte
part hashes that identifier with the existing source part ID. This prevents two collectors
with different segmentation from conflicting. Its predecessor identifies the source
part or migrated legacy generation and need not itself have archived records. Rewrites
hash the preceding part ID and the new source byte digest. Every generation is retained.

Segments within one part are contiguous, starting at zero. Each upload appends one
segment. Segment boundaries need not coincide with JSON or UTF-8 boundaries.

Format 2 checkpoints retain the shared checkpoint field names for compatibility
with the ledger and durable spool. `record_count` counts segments, and
`last_complete_byte_offset` means the captured byte offset. Neither is a JSON
record count or a claim that the tail is complete JSON. `complete_prefix_sha256`
hashes all captured source bytes. The existing prefix-chain proof binds appended
bytes to the previous checkpoint. Checkpoints and observations in a request must
have the same format. Switching an existing format 1 part to byte capture starts
a new part generation, preserving the old part and its pending uploads.

`observed_file_size` records the source extent seen when capture opened the file.
It can exceed the captured offset during backfill or after source loss. Export
reports both the verified captured length and `source_capture_complete`; a valid
archived prefix does not prove that the source's entire observed extent survived.

Discovery retains established session identity in encrypted local metadata. An
in-place malformed rewrite can reuse that identity after restart when the path
provenance and filesystem identity still match. A newly replaced unidentified
file must establish its own session identity. Current history consent is always
checked again before capture and upload.
Capture rechecks the opened file's identity and discovered header-prefix hash
before storing bytes. Malformed-header fallback requires Unix device, inode and
birth time. On platforms or filesystems where that identity is unavailable,
unidentified bytes fail closed; valid-header capture still works. Creation time
alone does not establish file identity. [Rust metadata availability](https://doc.rust-lang.org/std/fs/struct.Metadata.html#method.created).

New manifests use format 2 and retain the existing record/checkpoint element
layout. Byte-segment records additionally expose `source_byte_start` and
`source_byte_end`; these must agree with the authenticated record identity.
New roots and pages include an encrypted `archive_scope` identifying the organization,
contributor and source session, so an R2 inventory can recover scope after index loss.
Old record elements have no byte offsets and must not be represented as a
byte-exact reconstruction. New roots may reference old immutable format 1 pages.

A server receipt includes `request_sha256`, computed over the exact decompressed
JSON request bytes, the transcript part ID, captured byte offset, prefix digest,
and immutable manifest key. New byte-format collectors reject missing or
mismatched receipt fields. Legacy pending uploads retain their existing receipt
compatibility so an upgrade cannot strand them.

## Done

Rust and TypeScript fixtures agree on segment identity, payload encoding, prefix
hash and chain hash. Tests restore malformed, partial and oversized source bytes
exactly, reject gaps and mismatched receipts, and continue to read format 1.
