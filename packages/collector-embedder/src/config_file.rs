// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector embedder: config files other local users cannot steer.

//! Reading a config file that decides what the Collector uploads.
//!
//! A config's contents matter, and so does which file a path selects. Checking only the file that
//! opens would still let another user plant a symlink in a directory they can write to, pointing at
//! an older config of yours that lists more homes. So [`read`] applies ssh's `StrictModes` rule
//! while resolving the path: it passes only through directories the current user or root can
//! change, and follows only symlinks they could have placed. The file itself must be a regular file
//! the current user or root owns that no one else can change, checked on the opened handle
//! (`O_NONBLOCK`, so a FIFO cannot hang the read).
//!
//! Nothing another user can change decides which file is read, so no planted link, swapped
//! directory, or race can substitute a config. On other platforms the file is read as is.

use std::fs;
use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result};

use crate::private_file;

/// Read the config at `path`, or `None` when it does not exist.
pub fn read(path: &Path) -> Result<Option<String>> {
    let Some(mut file) = open_trusted(path)? else {
        return Ok(None);
    };
    private_file::ensure_regular(&file, path)?;
    ensure_trusted_file(&file, path)?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .with_context(|| format!("read {}", path.display()))?;
    Ok(Some(contents))
}

#[cfg(unix)]
fn open_trusted(path: &Path) -> Result<Option<fs::File>> {
    use crate::trusted_path::{self, Last};
    Ok(trusted_path::open(path, Last::File)?.map(fs::File::from))
}

#[cfg(unix)]
fn ensure_trusted_file(file: &fs::File, path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let meta = file
        .metadata()
        .with_context(|| format!("stat {}", path.display()))?;
    if !crate::trusted_path::is_trusted_owner(meta.uid()) {
        anyhow::bail!(
            "{} belongs to another user (uid {}), so it cannot be trusted; use a config you or \
             root own",
            path.display(),
            meta.uid()
        );
    }
    let mode = meta.mode() & 0o777;
    if mode & 0o022 != 0 {
        anyhow::bail!(
            "{} is writable by other users (mode {mode:o}), so it cannot be trusted; run \
             `chmod go-w` on it",
            path.display()
        );
    }
    Ok(())
}

#[cfg(not(unix))]
fn open_trusted(path: &Path) -> Result<Option<fs::File>> {
    match fs::File::open(path) {
        Ok(file) => Ok(Some(file)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("open {}", path.display())),
    }
}

#[cfg(not(unix))]
fn ensure_trusted_file(_file: &fs::File, _path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    const CONFIG: &str = "interval_minutes = 5";

    fn chmod(path: &Path, mode: u32) {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    fn write_config(path: &Path) {
        fs::write(path, CONFIG).unwrap();
        chmod(path, 0o644);
    }

    /// Explicit mode: the umask could leave a new directory group-writable, which would fail the walk.
    fn mkdir(path: &Path) {
        fs::create_dir(path).unwrap();
        chmod(path, 0o755);
    }

    #[test]
    fn a_config_reached_through_trusted_links_is_read() {
        let root = crate::test_support::private_tempdir();
        let target = root.path().join("dotfiles/collector.toml");
        mkdir(&root.path().join("dotfiles"));
        write_config(&target);
        let link = root.path().join("collector.toml");
        symlink("dotfiles/collector.toml", &link).unwrap();

        assert_eq!(read(&link).unwrap().as_deref(), Some(CONFIG));
        assert_eq!(read(&root.path().join("missing.toml")).unwrap(), None);
        assert_eq!(
            read(&root.path().join("missing/collector.toml")).unwrap(),
            None
        );
    }

    #[test]
    fn a_directory_others_can_write_to_breaks_trust_even_for_your_own_files() {
        let root = crate::test_support::private_tempdir();
        let shared = root.path().join("shared");
        mkdir(&shared);
        write_config(&shared.join("collector.toml"));
        chmod(&shared, 0o775);

        // Another user could have swapped this file, or planted a link to an older config of yours.
        let err = read(&shared.join("collector.toml"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("writable by other users"), "{err}");

        // A trusted link into that directory does not help: the path still runs through it.
        symlink(shared.join("collector.toml"), root.path().join("link.toml")).unwrap();
        let err = read(&root.path().join("link.toml"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("writable by other users"), "{err}");
    }

    #[test]
    fn a_file_others_can_change_is_refused_through_a_link() {
        let root = crate::test_support::private_tempdir();
        let target = root.path().join("collector.toml");
        write_config(&target);
        chmod(&target, 0o664);
        symlink(&target, root.path().join("link.toml")).unwrap();

        let err = read(&root.path().join("link.toml"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("writable by other users"), "{err}");
    }

    #[test]
    fn dot_dot_after_a_symlink_resolves_as_posix_does() {
        let root = crate::test_support::private_tempdir();
        mkdir(&root.path().join("real"));
        mkdir(&root.path().join("real/child"));
        write_config(&root.path().join("real/collector.toml"));
        fs::write(root.path().join("collector.toml"), "interval_minutes = 9").unwrap();
        chmod(&root.path().join("collector.toml"), 0o644);
        symlink(root.path().join("real/child"), root.path().join("link")).unwrap();

        assert_eq!(
            read(&root.path().join("link/../collector.toml"))
                .unwrap()
                .as_deref(),
            Some(CONFIG)
        );
    }

    #[test]
    fn a_planted_fifo_is_refused_without_blocking() {
        let root = crate::test_support::private_tempdir();
        let fifo = root.path().join("collector.toml");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        chmod(&fifo, 0o644);

        let err = read(&fifo).unwrap_err().to_string();
        assert!(err.contains("not a regular file"), "{err}");
    }

    #[test]
    fn root_owned_configs_in_root_owned_directories_are_trusted() {
        assert!(read(Path::new("/etc/passwd")).unwrap().is_some());
    }
}
