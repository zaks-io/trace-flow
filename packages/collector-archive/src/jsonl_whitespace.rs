pub(crate) fn is_archive_blank_byte(byte: &u8) -> bool {
    matches!(*byte, b'\t' | b'\x0c' | b'\r' | b' ')
}
