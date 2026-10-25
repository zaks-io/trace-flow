// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector embedder: state files other local users can neither read nor steer.

//! Files in the Collector's private state directory.
//!
//! The state directory holds the file credential store's secret and the connection metadata that
//! decides where that secret is sent, so other local users must never be able to read the secret
//! or plant a file that redirects it. On Unix:
//! - the directory is reached only through directories other users cannot change, following only
//!   symlinks the current user or root placed, so no link another user plants can point it
//!   elsewhere. Missing directories are created `0700` before anything is written in them.
//! - it must belong to the current user. One other users can only read, as an older version or a
//!   loose umask could leave it, is made `0700`. One they can write to is refused, never
//!   tightened: they could have swapped or planted files in it, and only its owner can tell.
//! - every entry must belong to the current user, checked on every use. That also covers files
//!   opened by other code, such as the SQLite cursor store and its sidecars.
//! - files are written and read through the handle of that checked directory. Writes go to a
//!   freshly and exclusively created `0600` temp file (`O_EXCL | O_NOFOLLOW`, random name) that is
//!   renamed over the target, so a pre-created file or planted symlink is never reused or followed,
//!   and a crash never leaves a truncated file.
//! - reads open with `O_NOFOLLOW` and check the opened handle. Both readers refuse a file another
//!   user owns; [`read`] (secrets) also refuses one other users can read, the way ssh refuses such a
//!   key, and [`read_owned`] (metadata) one other users can write.
//! - every reader opens with `O_NONBLOCK` and accepts only a regular file, so a FIFO planted in a
//!   file's place cannot hang the Collector before these checks run.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

use anyhow::{bail, Context, Result};

/// Atomically replace `path` with `contents`, readable only by the current user. The private
/// directory holding it is created first when missing.
pub fn write(path: &Path, contents: &[u8]) -> Result<()> {
    let (dir_path, name) = split(path)?;
    let dir = open_dir(dir_path, true)?;
    let tmp = temp_name(name)?;
    let mut file = sys::create_exclusive(&dir, &tmp)
        .with_context(|| format!("create {}", dir_path.join(&tmp).display()))?;
    let written = file
        .write_all(contents)
        .and_then(|()| file.sync_all())
        .with_context(|| format!("write {}", path.display()))
        .and_then(|()| {
            sys::rename(&dir, &tmp, name).with_context(|| format!("move into {}", path.display()))
        });
    if written.is_err() {
        let _ = sys::remove(&dir, &tmp);
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

/// Create `dir` (and missing ancestors) as `0700`, or make an existing one private, and refuse it
/// while other users can write to it or it holds their entries.
pub fn ensure_private_dir(dir: &Path) -> Result<()> {
    open_dir(dir, true).map(drop)
}

/// What a reader refuses besides symlinks and other owners.
#[derive(Clone, Copy)]
enum Guard {
    /// Permission bits that let other users read the file.
    Secret,
    /// Permission bits that let other users change the file.
    Trusted,
}

fn open_dir(dir: &Path, create: bool) -> Result<sys::Dir> {
    sys::open_private_dir(dir, create)?.with_context(|| format!("create {}", dir.display()))
}

fn open_checked(path: &Path, guard: Guard) -> Result<Option<fs::File>> {
    let (dir_path, name) = split(path)?;
    let Some(dir) = sys::open_private_dir(dir_path, false)? else {
        return Ok(None);
    };
    let file = match sys::open_no_follow(&dir, name) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) if sys::is_symlink_refusal(&err) => bail!(
            "{} is a symlink, so it cannot be trusted; delete it and run the command again",
            path.display()
        ),
        Err(err) => return Err(err).with_context(|| format!("open {}", path.display())),
    };
    ensure_regular(&file, path)?;
    sys::ensure_owned(&file, path, guard)?;
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

fn split(path: &Path) -> Result<(&Path, &OsStr)> {
    let name = path
        .file_name()
        .with_context(|| format!("{} does not name a file", path.display()))?;
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    Ok((dir, name))
}

fn temp_name(name: &OsStr) -> Result<OsString> {
    let mut nonce = [0u8; 8];
    getrandom::fill(&mut nonce).map_err(|err| anyhow::anyhow!("OS RNG: {err}"))?;
    let nonce: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(".{}.{nonce}.tmp", name.to_string_lossy()).into())
}

#[cfg(unix)]
mod sys {
    use std::ffi::{OsStr, OsString};
    use std::fs;
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;

    use anyhow::{bail, Context, Result};
    use rustix::fd::OwnedFd;
    use rustix::fs::{AtFlags, Mode, OFlags};

    use super::Guard;
    use crate::trusted_path::{self, Last};

    pub type Dir = OwnedFd;

    /// `dir` as a handle every later step goes through, or `None` when it does not exist and
    /// `create` is false.
    pub fn open_private_dir(dir: &Path, create: bool) -> Result<Option<OwnedFd>> {
        let Some(fd) = trusted_path::open(dir, Last::Dir { create })? else {
            return Ok(None);
        };
        let stat = rustix::fs::fstat(&fd).with_context(|| format!("stat {}", dir.display()))?;
        let uid = rustix::process::geteuid().as_raw();
        if stat.st_uid != uid {
            bail!(
                "{} belongs to another user; choose a state directory you own",
                dir.display()
            );
        }
        #[allow(clippy::useless_conversion, reason = "st_mode is u16 on macOS")]
        let mode = u32::from(stat.st_mode) & 0o777;
        if mode & 0o022 != 0 {
            bail!(
                "{} is writable by other users (mode {mode:o}), so the files in it cannot be \
                 trusted; check that everything in it is yours and as you left it, then run \
                 `chmod 700` on it",
                dir.display()
            );
        }
        if mode & 0o077 != 0 {
            rustix::fs::fchmod(&fd, Mode::from_raw_mode(0o700))
                .with_context(|| format!("restrict {} to its owner", dir.display()))?;
        }
        if let Some(entry) = foreign_entry(&fd, uid)? {
            bail!(
                "{} belongs to another user, so it may have been planted while others could \
                 write to {}; delete it and run the command again",
                dir.join(entry).display(),
                dir.display()
            );
        }
        Ok(Some(fd))
    }

    /// The first entry of `dir` not owned by `uid`, judged by the entry itself, so a link counts as
    /// its creator's whatever it points at.
    pub(super) fn foreign_entry(dir: &OwnedFd, uid: u32) -> Result<Option<OsString>> {
        for entry in rustix::fs::Dir::read_from(dir).context("list the state directory")? {
            let entry = entry.context("list the state directory")?;
            let name = OsStr::from_bytes(entry.file_name().to_bytes());
            if name == "." || name == ".." {
                continue;
            }
            let stat = match rustix::fs::statat(dir, name, AtFlags::SYMLINK_NOFOLLOW) {
                Ok(stat) => stat,
                // Renamed or removed since the listing, such as another writer's temp file.
                Err(rustix::io::Errno::NOENT) => continue,
                Err(err) => return Err(err).with_context(|| format!("stat {}", name.display())),
            };
            if stat.st_uid != uid {
                return Ok(Some(name.to_os_string()));
            }
        }
        Ok(None)
    }

    pub fn create_exclusive(dir: &OwnedFd, name: &OsStr) -> io::Result<fs::File> {
        let flags =
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let fd = rustix::fs::openat(dir, name, flags, Mode::from_raw_mode(0o600))?;
        Ok(fs::File::from(fd))
    }

    pub fn rename(dir: &OwnedFd, from: &OsStr, to: &OsStr) -> io::Result<()> {
        Ok(rustix::fs::renameat(dir, from, dir, to)?)
    }

    pub fn remove(dir: &OwnedFd, name: &OsStr) -> io::Result<()> {
        Ok(rustix::fs::unlinkat(dir, name, AtFlags::empty())?)
    }

    /// Non-blocking, so a FIFO opens at once and fails [`super::ensure_regular`]. Reads of a
    /// regular file ignore the flag.
    pub fn open_no_follow(dir: &OwnedFd, name: &OsStr) -> io::Result<fs::File> {
        let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
        let fd = rustix::fs::openat(dir, name, flags, Mode::empty())?;
        Ok(fs::File::from(fd))
    }

    /// `O_NOFOLLOW` fails with `ELOOP` when the last component is a symlink.
    pub fn is_symlink_refusal(err: &io::Error) -> bool {
        err.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error())
    }

    pub fn ensure_owned(file: &fs::File, path: &Path, guard: Guard) -> Result<()> {
        let meta = file
            .metadata()
            .with_context(|| format!("stat {}", path.display()))?;
        let mode = meta.mode() & 0o777;
        if meta.uid() != rustix::process::geteuid().as_raw() {
            bail!(
                "{} belongs to another user, so it cannot be trusted; delete it and run the \
                 command again",
                path.display()
            );
        }
        match guard {
            Guard::Secret if mode & 0o077 != 0 => bail!(
                "{} is readable by other users (mode {mode:o}); run `chmod 600` on it or log in \
                 again",
                path.display()
            ),
            Guard::Trusted if mode & 0o022 != 0 => bail!(
                "{} is writable by other users (mode {mode:o}), so it cannot be trusted; delete it \
                 and run the command again",
                path.display()
            ),
            _ => Ok(()),
        }
    }
}

#[cfg(not(unix))]
mod sys {
    use std::ffi::OsStr;
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};

    use anyhow::{Context, Result};

    use super::Guard;

    pub type Dir = PathBuf;

    pub fn open_private_dir(dir: &Path, create: bool) -> Result<Option<PathBuf>> {
        if create {
            fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        } else if !dir.is_dir() {
            return Ok(None);
        }
        Ok(Some(dir.to_path_buf()))
    }

    pub fn create_exclusive(dir: &Path, name: &OsStr) -> io::Result<fs::File> {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(name))
    }

    pub fn rename(dir: &Path, from: &OsStr, to: &OsStr) -> io::Result<()> {
        fs::rename(dir.join(from), dir.join(to))
    }

    pub fn remove(dir: &Path, name: &OsStr) -> io::Result<()> {
        fs::remove_file(dir.join(name))
    }

    pub fn open_no_follow(dir: &Path, name: &OsStr) -> io::Result<fs::File> {
        fs::File::open(dir.join(name))
    }

    pub fn is_symlink_refusal(_err: &io::Error) -> bool {
        false
    }

    pub fn ensure_owned(_file: &fs::File, _path: &Path, _guard: Guard) -> Result<()> {
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// Explicit mode: the umask decides what a plain `create_dir` leaves.
    fn mkdir(path: &Path, mode: u32) {
        fs::create_dir(path).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn writes_are_owner_only_and_hide_a_readable_directory() {
        let root = crate::test_support::private_tempdir();
        let dir = root.path().join("state");
        mkdir(&dir, 0o755);
        let path = dir.join("value");

        write(&path, b"one").unwrap();
        write(&path, b"two").unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("two"));
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "no temp files left");
    }

    #[test]
    fn a_directory_others_can_write_to_is_refused_not_tightened() {
        let root = crate::test_support::private_tempdir();
        let dir = root.path().join("state");
        mkdir(&dir, 0o775);
        fs::write(dir.join("value"), "swapped?").unwrap();
        fs::set_permissions(dir.join("value"), fs::Permissions::from_mode(0o600)).unwrap();

        for err in [
            write(&dir.join("value"), b"new").unwrap_err(),
            read(&dir.join("value")).unwrap_err(),
            ensure_private_dir(&dir).unwrap_err(),
        ] {
            assert!(err.to_string().contains("chmod 700"), "{err}");
        }
        assert_eq!(
            mode(&dir),
            0o775,
            "only its owner can tell what is safe to keep"
        );
        assert_eq!(fs::read_to_string(dir.join("value")).unwrap(), "swapped?");
    }

    #[test]
    fn a_state_dir_linked_from_a_directory_others_can_write_to_is_left_alone() {
        let root = crate::test_support::private_tempdir();
        let shared = root.path().join("shared");
        let victim = root.path().join("team-data");
        mkdir(&shared, 0o777);
        mkdir(&victim, 0o750);
        symlink(&victim, shared.join("trace-flow")).unwrap();

        let err = ensure_private_dir(&shared.join("trace-flow"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("writable by other users"), "{err}");
        assert_eq!(mode(&victim), 0o750, "the link target is never touched");
    }

    #[test]
    fn a_new_directory_is_private_from_the_start() {
        let root = crate::test_support::private_tempdir();
        let dir = root.path().join("a/b");
        ensure_private_dir(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&root.path().join("a")), 0o700);
    }

    #[test]
    fn entries_another_user_owns_are_found_whatever_they_point_at() {
        use std::os::unix::fs::MetadataExt;
        let root = crate::test_support::private_tempdir();
        let dir = root.path().join("state");
        ensure_private_dir(&dir).unwrap();
        // The target is root's; the link is this user's, and only the link counts.
        symlink("/", dir.join("cursors-org.sqlite3")).unwrap();
        ensure_private_dir(&dir).unwrap();

        let uid = fs::metadata(&dir).unwrap().uid();
        assert_ne!(uid, 0, "run these tests as a regular user");
        let fd = sys::open_private_dir(&dir, false).unwrap().unwrap();
        assert_eq!(sys::foreign_entry(&fd, uid).unwrap(), None);
        assert_eq!(
            sys::foreign_entry(&fd, uid + 1).unwrap(),
            Some("cursors-org.sqlite3".into())
        );
    }

    #[test]
    fn concurrent_writers_never_trip_over_each_others_temp_files() {
        let root = crate::test_support::private_tempdir();
        let dir = root.path().join("state");
        ensure_private_dir(&dir).unwrap();
        let writers: Vec<_> = ["service-state.json", "connection.json"]
            .into_iter()
            .map(|name| {
                let path = dir.join(name);
                std::thread::spawn(move || {
                    for i in 0..300 {
                        write(&path, format!("{i}").as_bytes()).unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().expect("every write succeeds");
        }
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2, "no temp files left");
    }

    #[test]
    fn a_planted_symlink_at_the_target_is_replaced_not_followed() {
        let root = crate::test_support::private_tempdir();
        let dir = root.path().join("state");
        let victim = root.path().join("victim");
        fs::write(&victim, "untouched").unwrap();
        mkdir(&dir, 0o700);
        let path = dir.join("value");
        symlink(&victim, &path).unwrap();

        write(&path, b"secret").unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "untouched");
        assert!(!fs::symlink_metadata(&path).unwrap().is_symlink());
        assert_eq!(mode(&path), 0o600);
    }

    #[test]
    fn secret_reads_refuse_symlinks_and_files_others_can_read() {
        let root = crate::test_support::private_tempdir();
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
        assert_eq!(read(&root.path().join("missing/value")).unwrap(), None);
    }

    #[test]
    fn a_planted_fifo_is_refused_without_blocking() {
        let root = crate::test_support::private_tempdir();
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
        let root = crate::test_support::private_tempdir();
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
