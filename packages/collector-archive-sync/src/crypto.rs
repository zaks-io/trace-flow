use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

use crate::error::{ArchiveSyncError, ArchiveSyncResult};
use crate::key_store::ArchiveSpoolKey;

const MAGIC: &[u8; 4] = b"TFAS";
const VERSION: u8 = 1;
const NONCE_LEN: usize = 12;

pub(crate) fn encrypt(
    key: &ArchiveSpoolKey,
    aad: &[u8],
    plaintext: &[u8],
) -> ArchiveSyncResult<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key.as_bytes()).map_err(|_| ArchiveSyncError::Crypto)?;
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|_| ArchiveSyncError::Crypto)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| ArchiveSyncError::Crypto)?;
    let mut out = Vec::with_capacity(MAGIC.len() + 1 + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub(crate) fn decrypt(
    key: &ArchiveSpoolKey,
    aad: &[u8],
    blob: &[u8],
) -> ArchiveSyncResult<Vec<u8>> {
    if blob.len() < MAGIC.len() + 1 + NONCE_LEN + 16 {
        return Err(ArchiveSyncError::Corrupt);
    }
    if &blob[..MAGIC.len()] != MAGIC {
        return Err(ArchiveSyncError::Corrupt);
    }
    if blob[MAGIC.len()] != VERSION {
        return Err(ArchiveSyncError::Corrupt);
    }
    let nonce_start = MAGIC.len() + 1;
    let nonce = &blob[nonce_start..nonce_start + NONCE_LEN];
    let ciphertext = &blob[nonce_start + NONCE_LEN..];
    let cipher = Aes256Gcm::new_from_slice(key.as_bytes()).map_err(|_| ArchiveSyncError::Crypto)?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| ArchiveSyncError::Corrupt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key_store::ArchiveSpoolKey;

    #[test]
    fn round_trip_authenticates_aad() {
        let key = ArchiveSpoolKey::generate().unwrap();
        let blob = encrypt(&key, b"pending:org:claude:s1", b"secret-body").unwrap();
        assert_eq!(
            decrypt(&key, b"pending:org:claude:s1", &blob).unwrap(),
            b"secret-body"
        );
        assert!(decrypt(&key, b"pending:org:claude:other", &blob).is_err());
    }

    #[test]
    fn flipped_ciphertext_fails_loud() {
        let key = ArchiveSpoolKey::generate().unwrap();
        let mut blob = encrypt(&key, b"aad", b"plain").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert!(matches!(
            decrypt(&key, b"aad", &blob),
            Err(ArchiveSyncError::Corrupt)
        ));
    }
}
