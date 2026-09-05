use crate::types::ArchiveError;

const MAX_IDENTIFIER_UTF16_CODE_UNITS: usize = 1024;

pub(crate) fn validate_identifier(value: &str, field: &'static str) -> Result<(), ArchiveError> {
    let is_windows_path = value.len() >= 2
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value.as_bytes()[1] == b':';
    if value.is_empty()
        || value.encode_utf16().count() > MAX_IDENTIFIER_UTF16_CODE_UNITS
        || value
            .chars()
            .any(|character| character <= '\u{001f}' || character == '\u{007f}')
        || value.starts_with(['/', '\\'])
        || value.contains(['/', '\\'])
        || is_windows_path
        || value == "."
        || value == ".."
    {
        return Err(ArchiveError::InvalidIdentifier { field });
    }
    Ok(())
}
