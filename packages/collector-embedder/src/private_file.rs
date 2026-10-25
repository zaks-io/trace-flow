// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector embedder: files only the current user can read, for the file credential store.

//! Owner-only files in a private directory.
//!
//! The file credential store keeps a secret on disk, so other local users must never be able to
//! read it or steer where it is written. On Unix:
//! - the directory must belong to the current user; it is tightened to `0700`.
//! - writes go to a freshly and exclusively created `0600` temp file (`O_EXCL | O_NOFOLLOW`, random
//!   name) that is renamed over the target, so a pre-created file or planted symlink is never
//!   reused or followed, and a crash never leaves a truncated secret.
//! - reads open with `O_NOFOLLOW` and check owner and mode on the opened handle, the way ssh refuses
//!   a key other users can read. A hand-copied file with loose permissions has already leaked.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// Atomically replace `path` (inside `dir`) with `contents`, readable only by the current user.
pub(crate) fn write(dir: &Path, path: &Path, contents: &str) -> Result<()> {
    ensure_private_dir(dir)?;
    let tmp = temp_path(path)?;
    let mut file = create_exclusive(&tmp).with_context(|| format!("create {}", tmp.display()))?;
    let written = file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
        .with_context(|| format!("write {}", tmp.display()))
        .and_then(|()| {
            fs::rename(&tmp, path).with_context(|| format!("move into {}", path.display()))
        });
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

/// Read `path`, or `None` when it does not exist. Fails when other users could read it, when it is
/// a symlink, or when another user owns it.
pub(crate) fn read(path: &Path) -> Result<Option<String>> {
    let mut file = match open_no_follow(path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err).with_context(|| format!("open {}", path.display())),
    };
    ensure_owner_only(&file, path)?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .with_context(|| format!("read {}", path.display()))?;
    Ok(Some(contents))
}

fn temp_path(path: &Path) -> Result<PathBuf> {
    let mut nonce = [0u8; 8];
    getrandom::fill(&mut nonce).map_err(|err| anyhow::anyhow!("OS RNG: {err}"))?;
    let nonce: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let name = path
        .file_name()
        .context("private file path has no file name")?
        .to_string_lossy();
    Ok(path.with_file_name(format!(".{name}.{nonce}.tmp")))
}

#[cfg(unix)]
fn ensure_private_dir(dir: &Path) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .with_context(|| format!("create {}", dir.display()))?;
    let meta = fs::metadata(dir).with_context(|| format!("stat {}", dir.display()))?;
    if meta.uid() != rustix::process::geteuid().as_raw() {
        bail!(
            "{} belongs to another user; choose a state directory you own",
            dir.display()
        );
    }
    if meta.mode() & 0o077 != 0 {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("restrict {} to its owner", dir.display()))?;
    }
    Ok(())
}

#[cfg(unix)]
fn create_exclusive(path: &Path) -> io::Result<fs::File> {
    use rustix::fs::{Mode, OFlags};
    let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let fd = rustix::fs::open(path, flags, Mode::from_raw_mode(0o600))?;
    Ok(fs::File::from(fd))
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> io::Result<fs::File> {
    use rustix::fs::{Mode, OFlags};
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let fd = rustix::fs::open(path, flags, Mode::empty())?;
    Ok(fs::File::from(fd))
}

#[cfg(unix)]
fn ensure_owner_only(file: &fs::File, path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let meta = file
        .metadata()
        .with_context(|| format!("stat {}", path.display()))?;
    if meta.uid() != rustix::process::geteuid().as_raw() {
        bail!("{} belongs to another user; log in again", path.display());
    }
    if meta.mode() & 0o077 != 0 {
        bail!(
            "{} is readable by other users (mode {:o}); run `chmod 600` on it or log in again",
            path.display(),
            meta.mode() & 0o777
        );
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_private_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))
}

#[cfg(not(unix))]
fn create_exclusive(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

#[cfg(not(unix))]
fn open_no_follow(path: &Path) -> io::Result<fs::File> {
    fs::File::open(path)
}

#[cfg(not(unix))]
fn ensure_owner_only(_file: &fs::File, _path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn writes_are_owner_only_and_tighten_the_directory() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("state");
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o775)).unwrap();
        let path = dir.join("value");

        write(&dir, &path, "one").unwrap();
        write(&dir, &path, "two").unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("two"));
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "no temp files left");
    }

    #[test]
    fn a_planted_symlink_at_the_target_is_replaced_not_followed() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("state");
        let victim = root.path().join("victim");
        fs::write(&victim, "untouched").unwrap();
        fs::create_dir(&dir).unwrap();
        let path = dir.join("value");
        symlink(&victim, &path).unwrap();

        write(&dir, &path, "secret").unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "untouched");
        assert!(!fs::symlink_metadata(&path).unwrap().is_symlink());
        assert_eq!(mode(&path), 0o600);
    }

    #[test]
    fn reads_refuse_symlinks_and_loose_permissions() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        fs::write(&target, "secret").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let link = root.path().join("link");
        symlink(&target, &link).unwrap();
        assert!(read(&link).is_err());

        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        let err = read(&target).unwrap_err().to_string();
        assert!(err.contains("readable by other users"), "{err}");

        assert_eq!(read(&root.path().join("missing")).unwrap(), None);
    }
}
