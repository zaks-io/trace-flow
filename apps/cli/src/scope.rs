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

    /// The config, or `None` when its file does not exist yet. Wherever it lives, it is read only if
    /// you or root own it and no one else can change it (see [`Config::load`]).
    pub fn config(&self) -> Result<Option<Config>> {
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
