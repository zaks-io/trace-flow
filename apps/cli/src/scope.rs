// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: per-user and host-wide file layouts.

//! Where the CLI keeps its config, state, and systemd unit.
//!
//! **Per-user** (the default) keeps everything under the user's config dir and runs as a
//! `systemctl --user` service that reads that user's agent homes. **Host-wide** (`--system`) is one
//! root-owned service per machine that reads many users' homes with a single Collector Credential,
//! so its config lives in `/etc` and its state in `/var/lib`, outside any user's reach.

use std::path::{Path, PathBuf};
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
    pub fn resolve(scope: Scope, config_override: Option<PathBuf>) -> Result<Self> {
        let home = dirs::home_dir().context("could not resolve home directory")?;
        let (default_config, paths) = match scope {
            Scope::User => {
                let config_dir = dirs::config_dir().context("no OS config dir")?;
                (
                    config_dir.join("trace-flow").join("collector.toml"),
                    Paths::resolve()?,
                )
            }
            Scope::System => (
                PathBuf::from(SYSTEM_CONFIG_FILE),
                Paths::at(PathBuf::from(SYSTEM_STATE_DIR)),
            ),
        };
        Ok(Self {
            scope,
            config_overridden: config_override.is_some(),
            config_file: config_override.unwrap_or(default_config),
            paths,
            home,
        })
    }

    /// The config, or `None` when its file does not exist yet.
    ///
    /// The per-user default config lives in a directory the Collector owns, normally the state dir,
    /// and so does any config placed in the state dir. That directory is made private and checked
    /// for planted entries *before* the config is read: while it was open, another user could plant
    /// a config, let it be opened, and remove it, and a later check would find nothing wrong.
    pub fn config(&self) -> Result<Option<Config>> {
        let collector_owned = self.scope == Scope::User && !self.config_overridden;
        if collector_owned || self.config_file.starts_with(self.paths.root()) {
            let dir = self
                .config_file
                .parent()
                .context("config path has no directory")?;
            // No directory, no config: leave creating it to the commands that write one.
            if dir
                .try_exists()
                .with_context(|| format!("check {}", dir.display()))?
            {
                private_file::ensure_private_dir(dir)?;
            }
        }
        Config::load(&self.config_file)
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
