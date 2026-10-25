// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector embedder: state files other local users can neither read nor steer.

//! Files in the Collector's private state directory.
//!
//! The state directory holds the file credential store's secret and the connection metadata that
//! decides where that secret is sent, so other local users must never be able to read the secret
//! or plant a file that redirects it. On Unix:
//! - the directory is created `0700` before anything is written in it and must belong to the
//!   current user. One that an older version or a loose umask left open is tightened to `0700`.
//!   Every entry must belong to the current user, checked on every use, because anything else was
//!   planted while the directory was open. That also covers files opened by other code, such as
//!   the SQLite cursor store and its sidecars.
//! - writes go to a freshly and exclusively created `0600` temp file (`O_EXCL | O_NOFOLLOW`, random
//!   name) that is renamed over the target, so a pre-created file or planted symlink is never
//!   reused or followed, and a crash never leaves a truncated file.
//! - reads open with `O_NOFOLLOW` and check the opened handle. Both readers refuse a file another
//!   user owns; [`read`] (secrets) also refuses one other users can read, the way ssh refuses such a
//!   key, and [`read_owned`] (metadata) one other users can write.
//! - every reader here opens with `O_NONBLOCK` and accepts only a regular file, so a FIFO planted
//!   in a file's place cannot hang the Collector before these checks run.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// Atomically replace `path` (inside `dir`) with `contents`, readable only by the current user.
pub fn write(dir: &Path, path: &Path, contents: &[u8]) -> Result<()> {
    ensure_private_dir(dir)?;
    let tmp = temp_path(path)?;
    let mut file = create_exclusive(&tmp).with_context(|| format!("create {}", tmp.display()))?;
    let written = file
        .write_all(contents)
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

/// Read the secret at `path`, or `None` when it does not exist. Fails when it is a symlink, another
/// user owns it, or other users can read it.
pub fn read(path: &Path) -> Result<Option<String>> {
    let Some(mut file) = open_checked(path, Guard::Secret)? else {
        return Ok(None);
    };
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .with_context(|| format!("read {}", path.display()))?;
    Ok(Some(contents))
}

/// Read non-secret state at `path`, or `None` when it does not exist. Other users may read it, but
/// it fails when it is a symlink, another user owns it, or other users can write it.
pub fn read_owned(path: &Path) -> Result<Option<Vec<u8>>> {
    let Some(mut file) = open_checked(path, Guard::Trusted)? else {
        return Ok(None);
    };
    let mut contents = Vec::new();
    file.read_to_end(&mut contents)
        .with_context(|| format!("read {}", path.display()))?;
    Ok(Some(contents))
}

/// What a reader refuses besides symlinks and other owners.
#[derive(Clone, Copy)]
enum Guard {
    /// Permission bits that let other users read the file.
    Secret,
    /// Permission bits that let other users change the file.
    Trusted,
}

fn open_checked(path: &Path, guard: Guard) -> Result<Option<fs::File>> {
    let file = match open_no_follow(path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) if is_symlink_refusal(&err) => bail!(
            "{} is a symlink, so it cannot be trusted; delete it and run the command again",
            path.display()
        ),
        Err(err) => return Err(err).with_context(|| format!("open {}", path.display())),
    };
    ensure_regular(&file, path)?;
    ensure_owned(&file, path, guard)?;
    Ok(Some(file))
}

/// `O_NONBLOCK` let a FIFO or device open without waiting; reading one could still block.
pub(crate) fn ensure_regular(file: &fs::File, path: &Path) -> Result<()> {
    let meta = file
        .metadata()
        .with_context(|| format!("stat {}", path.display()))?;
    if !meta.file_type().is_file() {
        bail!(
            "{} is not a regular file; delete it and run the command again",
            path.display()
        );
    }
    Ok(())
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

/// Create `dir` (and missing ancestors) as `0700`, or make an existing one private, and refuse it
/// while it holds another user's entries.
#[cfg(unix)]
pub fn ensure_private_dir(dir: &Path) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .with_context(|| format!("create {}", dir.display()))?;
    let meta = fs::metadata(dir).with_context(|| format!("stat {}", dir.display()))?;
    let uid = rustix::process::geteuid().as_raw();
    if meta.uid() != uid {
        bail!(
            "{} belongs to another user; choose a state directory you own",
            dir.display()
        );
    }
    if meta.mode() & 0o077 != 0 {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("restrict {} to its owner", dir.display()))?;
    }
    // Nobody else can add entries now, so this cannot race. It runs every time rather than only
    // when the mode changed: a refused attempt has already tightened the directory, and a retry
    // must refuse the planted entry again.
    if let Some(planted) = foreign_entry(dir, uid)? {
        bail!(
            "{} belongs to another user, so it was planted while other users could write to {}; \
             delete it and run the command again",
            planted.display(),
            dir.display()
        );
    }
    Ok(())
}

/// The first entry of `dir` not owned by `uid`. `DirEntry::metadata` does not follow symlinks, so a
/// planted link counts as its creator's.
#[cfg(unix)]
fn foreign_entry(dir: &Path, uid: u32) -> Result<Option<PathBuf>> {
    use std::os::unix::fs::MetadataExt;
    let entries = fs::read_dir(dir).with_context(|| format!("list {}", dir.display()))?;
    for entry in entries {
        let entry = entry.with_context(|| format!("list {}", dir.display()))?;
        let meta = entry
            .metadata()
            .with_context(|| format!("stat {}", entry.path().display()))?;
        if meta.uid() != uid {
            return Ok(Some(entry.path()));
        }
    }
    Ok(None)
}

#[cfg(unix)]
fn create_exclusive(path: &Path) -> io::Result<fs::File> {
    use rustix::fs::{Mode, OFlags};
    let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let fd = rustix::fs::open(path, flags, Mode::from_raw_mode(0o600))?;
    Ok(fs::File::from(fd))
}

/// Non-blocking, so a FIFO opens at once and fails [`ensure_regular`]. Reads of a regular file
/// ignore the flag.
#[cfg(unix)]
fn open_no_follow(path: &Path) -> io::Result<fs::File> {
    use rustix::fs::{Mode, OFlags};
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
    let fd = rustix::fs::open(path, flags, Mode::empty())?;
    Ok(fs::File::from(fd))
}

/// `O_NOFOLLOW` fails with `ELOOP` when the last component is a symlink.
#[cfg(unix)]
fn is_symlink_refusal(err: &io::Error) -> bool {
    err.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error())
}

#[cfg(unix)]
fn ensure_owned(file: &fs::File, path: &Path, guard: Guard) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let meta = file
        .metadata()
        .with_context(|| format!("stat {}", path.display()))?;
    let mode = meta.mode() & 0o777;
    if meta.uid() != rustix::process::geteuid().as_raw() {
        bail!(
            "{} belongs to another user, so it cannot be trusted; delete it and run the command again",
            path.display()
        );
    }
    match guard {
        Guard::Secret if mode & 0o077 != 0 => bail!(
            "{} is readable by other users (mode {mode:o}); run `chmod 600` on it or log in again",
            path.display()
        ),
        Guard::Trusted if mode & 0o022 != 0 => bail!(
            "{} is writable by other users (mode {mode:o}), so it cannot be trusted; delete it and \
             run the command again",
            path.display()
        ),
        _ => Ok(()),
    }
}

#[cfg(not(unix))]
pub fn ensure_private_dir(dir: &Path) -> Result<()> {
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
fn is_symlink_refusal(_err: &io::Error) -> bool {
    false
}

#[cfg(not(unix))]
fn ensure_owned(_file: &fs::File, _path: &Path, _guard: Guard) -> Result<()> {
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

        write(&dir, &path, b"one").unwrap();
        write(&dir, &path, b"two").unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("two"));
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "no temp files left");
    }

    #[test]
    fn a_new_directory_is_private_from_the_start() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("a/b");
        ensure_private_dir(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&root.path().join("a")), 0o700);
    }

    #[test]
    fn entries_another_user_owns_are_found_whatever_the_directory_mode() {
        use std::os::unix::fs::MetadataExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("state");
        ensure_private_dir(&dir).unwrap();
        // The target is root's; the link is this user's, and only the link counts.
        symlink("/", dir.join("cursors-org.sqlite3")).unwrap();
        ensure_private_dir(&dir).unwrap();

        let uid = fs::metadata(&dir).unwrap().uid();
        assert_ne!(uid, 0, "run these tests as a regular user");
        assert_eq!(foreign_entry(&dir, uid).unwrap(), None);
        assert_eq!(
            foreign_entry(&dir, uid + 1).unwrap(),
            Some(dir.join("cursors-org.sqlite3"))
        );
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

        write(&dir, &path, b"secret").unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "untouched");
        assert!(!fs::symlink_metadata(&path).unwrap().is_symlink());
        assert_eq!(mode(&path), 0o600);
    }

    #[test]
    fn secret_reads_refuse_symlinks_and_files_others_can_read() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        fs::write(&target, "secret").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let link = root.path().join("link");
        symlink(&target, &link).unwrap();
        let err = read(&link).unwrap_err().to_string();
        assert!(err.contains("is a symlink"), "{err}");

        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        let err = read(&target).unwrap_err().to_string();
        assert!(err.contains("readable by other users"), "{err}");

        assert_eq!(read(&root.path().join("missing")).unwrap(), None);
    }

    #[test]
    fn a_planted_fifo_is_refused_without_blocking() {
        let root = tempfile::tempdir().unwrap();
        let fifo = root.path().join("connection.json");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(made.success());
        fs::set_permissions(&fifo, fs::Permissions::from_mode(0o600)).unwrap();

        for err in [read(&fifo).unwrap_err(), read_owned(&fifo).unwrap_err()] {
            assert!(err.to_string().contains("not a regular file"), "{err}");
        }
    }

    #[test]
    fn owned_reads_allow_readers_but_refuse_symlinks_and_files_others_can_write() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        fs::write(&target, "{}").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read_owned(&target).unwrap().as_deref(), Some(&b"{}"[..]));

        let link = root.path().join("link");
        symlink(&target, &link).unwrap();
        assert!(read_owned(&link).is_err());

        fs::set_permissions(&target, fs::Permissions::from_mode(0o664)).unwrap();
        let err = read_owned(&target).unwrap_err().to_string();
        assert!(err.contains("writable by other users"), "{err}");

        assert_eq!(read_owned(&root.path().join("missing")).unwrap(), None);
    }
}
