// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: per-user and host-wide file layouts.

//! Where the CLI keeps its config, state, and systemd unit.
//!
//! **Per-user** (the default) keeps everything under the user's config dir and runs as a
//! `systemctl --user` service that reads that user's agent homes. **Host-wide** (`--system`) is one
//! root-owned service per machine that reads many users' homes with a single Collector Credential,
//! so its config lives in `/etc` and its state in `/var/lib`, outside any user's reach.

use std::path::{Component, Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};
use collector_embedder::connection::Paths;
use collector_embedder::keychain::{CredentialStore, CredentialStoreKind};
use collector_embedder::private_file;
use collector_embedder::sources::SourceHomes;

use crate::config::{Config, ConfigError};

const SYSTEM_CONFIG_FILE: &str = "/etc/trace-flow/collector.toml";
const SYSTEM_STATE_DIR: &str = "/var/lib/trace-flow";
const SYSTEM_UNIT_DIR: &str = "/etc/systemd/system";
pub const UNIT_NAME: &str = "trace-flow.service";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    User,
    System,
}

impl Scope {
    /// The global flags that select this scope, for messages that tell the user what to run next.
    pub fn flag(self) -> &'static str {
        match self {
            Self::User => "",
            Self::System => " --system",
        }
    }

    /// `systemctl` (or `journalctl`) addressed at this scope's service manager.
    pub fn manager_command(self, program: &str) -> Command {
        let mut command = Command::new(program);
        if self == Self::User {
            command.arg("--user");
        }
        command
    }

    /// The same command as text, for telling the user what to run.
    pub fn hint(self, program: &str, args: &str) -> String {
        match self {
            Self::User => format!("{program} --user {args}"),
            Self::System => format!("{program} {args}"),
        }
    }
}

pub struct Layout {
    pub scope: Scope,
    pub config_file: PathBuf,
    /// Whether `config_file` came from `--config` rather than the scope default.
    pub config_overridden: bool,
    pub paths: Paths,
    pub home: PathBuf,
}

impl Layout {
    /// Resolve the layout. The config and state paths are made absolute and lexically normalized
    /// here, so [`Self::config`] can tell whether one lies inside the other however they were spelled.
    pub fn resolve(scope: Scope, config_override: Option<PathBuf>) -> Result<Self> {
        let home = dirs::home_dir().context("could not resolve home directory")?;
        let (default_config, state_dir) = match scope {
            Scope::User => {
                let config_dir = dirs::config_dir().context("no OS config dir")?;
                (
                    config_dir.join("trace-flow").join("collector.toml"),
                    Paths::resolve()?.root().to_path_buf(),
                )
            }
            Scope::System => (
                PathBuf::from(SYSTEM_CONFIG_FILE),
                PathBuf::from(SYSTEM_STATE_DIR),
            ),
        };
        Ok(Self {
            scope,
            config_overridden: config_override.is_some(),
            config_file: normalized(&config_override.unwrap_or(default_config))?,
            paths: Paths::at(normalized(&state_dir)?),
            home,
        })
    }

    /// The config, or `None` when its file does not exist yet.
    ///
    /// A config in a directory other users could once write to is only read after that directory
    /// is private and checked for planted entries: another user could plant a config, let it be
    /// opened, and remove it, and a check after the read would find nothing wrong.
    /// - In the state dir, which [`Paths::ensure`] tightens, a config must sit directly in it, as
    ///   the per-user default does: subdirectories are not checked.
    /// - The per-user default config's own directory, when `TRACE_FLOW_STATE_DIR` moves the state
    ///   elsewhere, belongs to the Collector too and gets the same treatment.
    /// - Any other config, an explicit `--config` or the host-wide default in root-owned `/etc`, is
    ///   its owner's to protect. It is read at its resolved location, so a symlink that leads back
    ///   into the state dir is refused rather than followed.
    pub fn config(&self) -> Result<Option<Config>> {
        let file = &self.config_file;
        let state = self.paths.root();
        if file.starts_with(state) {
            if file.parent() != Some(state) {
                return Err(ConfigError(format!(
                    "{} is in a subdirectory of the state directory {}; keep collector.toml \
                     directly in it or outside it",
                    file.display(),
                    state.display()
                ))
                .into());
            }
            return load_from_private_dir(state, file);
        }
        if self.scope == Scope::User && !self.config_overridden {
            let dir = file.parent().context("config path has no directory")?;
            return load_from_private_dir(dir, file);
        }
        let resolved = match std::fs::canonicalize(file) {
            Ok(resolved) => resolved,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err).with_context(|| format!("resolve {}", file.display())),
        };
        if let Ok(real_state) = std::fs::canonicalize(state) {
            if resolved.starts_with(&real_state) {
                return Err(ConfigError(format!(
                    "{} leads into the state directory {}; keep the config outside it, or \
                     directly in it under that path",
                    file.display(),
                    state.display()
                ))
                .into());
            }
        }
        Config::load(&resolved)
    }

    /// The config for a command that reads inputs. A `--config` path must exist: falling back to
    /// the default homes would upload sources the named config was written to exclude.
    pub fn input_config(&self) -> Result<Option<Config>> {
        let config = self.config()?;
        if config.is_none() && self.config_overridden {
            return Err(
                ConfigError(format!("{} does not exist", self.config_file.display())).into(),
            );
        }
        Ok(config)
    }

    /// The store a new login writes the credential to. Later commands use the store the
    /// connection recorded, so they never need the config to find the credential.
    pub fn login_credentials(&self, config: Option<&Config>) -> CredentialStore {
        let kind = config
            .and_then(|config| config.credential_store)
            .unwrap_or_else(CredentialStoreKind::platform_default);
        CredentialStore::new(kind, &self.paths)
    }

    /// The agent homes to read. Per-user without a config reads the standard homes this process
    /// resolves; host-wide has no sensible default, so it needs a config naming the homes.
    pub fn source_homes(&self, config: Option<&Config>) -> Result<SourceHomes> {
        match (config, self.scope) {
            (Some(config), _) => config.source_homes(&self.home),
            (None, Scope::User) => Ok(SourceHomes::resolve(&self.home)),
            (None, Scope::System) => Err(ConfigError(format!(
                "host-wide mode reads only the inputs in {}; run `trace-flow --system service install` to create it",
                self.config_file.display()
            ))
            .into()),
        }
    }

    pub fn unit_file(&self) -> Result<PathBuf> {
        Ok(match self.scope {
            Scope::User => dirs::config_dir()
                .context("no OS config dir")?
                .join("systemd")
                .join("user")
                .join(UNIT_NAME),
            Scope::System => Path::new(SYSTEM_UNIT_DIR).join(UNIT_NAME),
        })
    }

    /// The global arguments that make another invocation use this same layout.
    pub fn global_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if self.scope == Scope::System {
            args.push("--system".to_string());
        }
        if self.config_overridden {
            args.push("--config".to_string());
            args.push(self.config_file.display().to_string());
        }
        args
    }
}

/// Make `dir` private and refuse planted entries, then read `file` in it. No directory means no
/// config, and read-only commands must not create one.
fn load_from_private_dir(dir: &Path, file: &Path) -> Result<Option<Config>> {
    if !dir
        .try_exists()
        .with_context(|| format!("check {}", dir.display()))?
    {
        return Ok(None);
    }
    private_file::ensure_private_dir(dir)?;
    Config::load(file)
}

/// `path` made absolute against the working directory, with `.` and `..` removed lexically.
fn normalized(path: &Path) -> Result<PathBuf> {
    let absolute =
        std::path::absolute(path).with_context(|| format!("resolve {}", path.display()))?;
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    Ok(out)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn layout(root: &Path, config_file: PathBuf, config_overridden: bool) -> Layout {
        Layout {
            scope: Scope::User,
            config_file,
            config_overridden,
            paths: Paths::at(root.join("state")),
            home: root.to_path_buf(),
        }
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn open_dir(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o775)).unwrap();
    }

    #[test]
    fn the_config_directory_is_private_before_the_config_is_read() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state");
        open_dir(&state);
        // Unparseable, so the read fails: the directory must already be private by then.
        std::fs::write(state.join("collector.toml"), "colour = \"blue\"").unwrap();
        let layout = layout(root.path(), state.join("collector.toml"), false);

        assert!(layout.input_config().is_err());
        assert_eq!(mode(&state), 0o700);
    }

    #[test]
    fn reading_a_missing_config_creates_no_directory() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("config/trace-flow");
        let layout = layout(root.path(), dir.join("collector.toml"), false);

        assert_eq!(layout.config().unwrap(), None);
        assert!(!dir.exists());
    }

    #[test]
    fn paths_are_compared_absolute_and_normalized() {
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(
            normalized(Path::new("state/./x/../collector.toml")).unwrap(),
            cwd.join("state/collector.toml")
        );
    }

    #[test]
    fn a_config_spelled_into_the_state_dir_is_read_only_after_it_is_private() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state");
        open_dir(&state);
        std::fs::write(state.join("collector.toml"), "colour = \"blue\"").unwrap();
        let spelled = normalized(&root.path().join("other/../state/collector.toml")).unwrap();
        let layout = layout(root.path(), spelled, true);

        assert!(layout.input_config().is_err());
        assert_eq!(mode(&state), 0o700);
    }

    #[test]
    fn a_config_nested_in_the_state_dir_or_reached_through_a_symlink_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state");
        std::fs::create_dir_all(state.join("nested")).unwrap();
        std::fs::write(state.join("nested/collector.toml"), "").unwrap();
        let nested = layout(root.path(), state.join("nested/collector.toml"), true);
        let err = nested.config().unwrap_err().to_string();
        assert!(err.contains("subdirectory of the state directory"), "{err}");

        let link = root.path().join("dotfiles");
        std::os::unix::fs::symlink(state.join("nested"), &link).unwrap();
        let linked = layout(root.path(), link.join("collector.toml"), true);
        let err = linked.config().unwrap_err().to_string();
        assert!(err.contains("leads into the state directory"), "{err}");
    }

    #[test]
    fn an_explicit_config_elsewhere_leaves_its_directory_alone() {
        let root = tempfile::tempdir().unwrap();
        let elsewhere = root.path().join("repo");
        open_dir(&elsewhere);
        std::fs::write(
            elsewhere.join("collector.toml"),
            "[[inputs]]\nname = \"c\"\nsource = \"claude\"\npath = \"~/.claude\"\n",
        )
        .unwrap();
        let layout = layout(root.path(), elsewhere.join("collector.toml"), true);

        assert!(layout.input_config().unwrap().is_some());
        assert_eq!(mode(&elsewhere), 0o775);
    }
}
