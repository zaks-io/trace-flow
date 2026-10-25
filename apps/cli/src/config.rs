// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: the `collector.toml` service configuration.

//! Which agent homes the Collector reads, and how often.
//!
//! Without a config file the per-user CLI reads the standard homes (plus `CLAUDE_CONFIG_DIR` and
//! `CODEX_HOME`). A config file replaces that with an explicit list of inputs, which a systemd
//! service needs because it does not inherit a login shell's environment, and which a host-wide
//! service needs to name other users' homes. Inputs may be globs, re-expanded on every cycle, so
//! homes created later are picked up without a restart.
//!
//! A config that does not parse, names an unknown key, or holds an invalid value is a
//! [`ConfigError`], which exits with `EX_CONFIG` so systemd stops restarting the service.

use std::collections::HashSet;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use collector_contracts::AgentSource;
use collector_embedder::cycle;
use collector_embedder::keychain::CredentialStoreKind;
use collector_embedder::sources::SourceHomes;
use collector_embedder::sync::{self, Window};
use serde::{Deserialize, Serialize};

/// A configuration or setup problem only a person can fix. Exits with status 78 (`EX_CONFIG`).
#[derive(Debug)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default = "default_interval_minutes")]
    pub interval_minutes: u64,
    /// History the first service pass imports: `24h`, `7d`, `30d`, or `1y`.
    #[serde(default = "default_first_backfill")]
    pub first_backfill: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_store: Option<CredentialStoreKind>,
    pub inputs: Vec<Input>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    /// The label status and logs show instead of the path.
    pub name: String,
    pub source: InputSource,
    /// The agent home: what `CLAUDE_CONFIG_DIR` or `CODEX_HOME` would name. Absolute or `~/`, and
    /// may contain glob patterns.
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputSource {
    Claude,
    Codex,
}

impl InputSource {
    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn agent_source(self) -> AgentSource {
        match self {
            Self::Claude => AgentSource::Claude,
            Self::Codex => AgentSource::Codex,
        }
    }
}

fn default_interval_minutes() -> u64 {
    cycle::DEFAULT_INTERVAL.as_secs() / 60
}

fn default_first_backfill() -> String {
    cycle::DEFAULT_FIRST_BACKFILL.to_string()
}

const HEADER: &str = "\
# Trace Flow Collector configuration, read by `trace-flow sync --watch` and the other commands.
#
# Each [[inputs]] entry is one agent home: the directory CLAUDE_CONFIG_DIR or CODEX_HOME would
# name. Paths are absolute or start with ~/, and may contain * globs. Globs are expanded again on
# every cycle, so homes created later are picked up without a restart. `name` is the label status
# and logs show instead of the path.
#
# Restart the service after editing: systemctl [--user] restart trace-flow.service
";

impl Config {
    pub fn parse(text: &str) -> Result<Self, ConfigError> {
        let config: Self = toml::from_str(text).map_err(|err| ConfigError(err.to_string()))?;
        config.validate()?;
        Ok(config)
    }

    /// Read `path`, or `None` when it does not exist.
    pub fn load(path: &Path) -> anyhow::Result<Option<Self>> {
        match std::fs::read_to_string(path) {
            Ok(text) => Self::parse(&text)
                .map(Some)
                .map_err(|err| ConfigError(format!("{}: {err}", path.display())).into()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(anyhow::Error::new(err).context(format!("read {}", path.display()))),
        }
    }

    pub fn render(&self) -> anyhow::Result<String> {
        Ok(format!("{HEADER}\n{}", toml::to_string(self)?))
    }

    /// The per-user starting point: the homes this shell resolves today, written down so the service
    /// keeps reading them without this shell's environment.
    pub fn for_user(home: &Path, homes: &SourceHomes) -> Self {
        let mut inputs = Vec::new();
        for (source, dirs) in [
            (InputSource::Claude, &homes.claude_config_dirs),
            (InputSource::Codex, &homes.codex_homes),
        ] {
            for (index, dir) in dirs.iter().enumerate() {
                let label = source.label();
                inputs.push(Input {
                    name: if index == 0 {
                        label.to_string()
                    } else {
                        format!("{label}-{}", index + 1)
                    },
                    source,
                    path: collapse_home(home, dir),
                });
            }
        }
        Self::with_inputs(inputs)
    }

    /// The host-wide starting point: every local user's standard homes.
    pub fn for_host() -> Self {
        Self::with_inputs(vec![
            Input {
                name: "claude".to_string(),
                source: InputSource::Claude,
                path: "/home/*/.claude".to_string(),
            },
            Input {
                name: "codex".to_string(),
                source: InputSource::Codex,
                path: "/home/*/.codex".to_string(),
            },
        ])
    }

    fn with_inputs(inputs: Vec<Input>) -> Self {
        Self {
            interval_minutes: default_interval_minutes(),
            first_backfill: default_first_backfill(),
            credential_store: None,
            inputs,
        }
    }

    pub fn interval(&self) -> Duration {
        Duration::from_secs(self.interval_minutes * 60)
    }

    pub fn first_backfill(&self) -> Window {
        sync::window_from_since(&self.first_backfill)
            .expect("first_backfill is checked when the config is parsed")
    }

    /// Every input's current homes, merged into the shape the sync loop reads.
    pub fn source_homes(&self, home: &Path) -> SourceHomes {
        let mut merged = SourceHomes::default();
        for input in &self.inputs {
            merged.merge(&input.source_homes(home));
        }
        merged
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.interval_minutes == 0 {
            return Err(ConfigError(
                "interval_minutes must be at least 1".to_string(),
            ));
        }
        sync::window_from_since(&self.first_backfill).map_err(|_| {
            ConfigError("first_backfill must be one of 24h, 7d, 30d, 1y".to_string())
        })?;
        if self.inputs.is_empty() {
            return Err(ConfigError(
                "at least one [[inputs]] entry is required".to_string(),
            ));
        }
        let mut names = HashSet::new();
        for input in &self.inputs {
            if input.name.trim().is_empty() {
                return Err(ConfigError(
                    "every input needs a non-empty name".to_string(),
                ));
            }
            if !names.insert(input.name.as_str()) {
                return Err(ConfigError(format!(
                    "input name {:?} is used twice",
                    input.name
                )));
            }
            if !(input.path.starts_with('/') || input.path.starts_with("~/")) {
                return Err(ConfigError(format!(
                    "input {:?}: path must be absolute or start with ~/",
                    input.name
                )));
            }
            glob::Pattern::new(&input.path).map_err(|err| {
                ConfigError(format!("input {:?}: invalid glob: {err}", input.name))
            })?;
        }
        Ok(())
    }
}

impl Input {
    /// The agent homes this input names right now. A literal path is kept even before it exists, so
    /// it starts syncing as soon as the agent creates it; a glob lists only the directories it
    /// currently matches.
    pub fn homes(&self, home: &Path) -> Vec<PathBuf> {
        let path = match self.path.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None => PathBuf::from(&self.path),
        };
        let pattern = path.to_string_lossy();
        if !pattern.contains(['*', '?', '[']) {
            return vec![path];
        }
        let mut matches: Vec<PathBuf> = glob::glob(&pattern)
            .map(|paths| paths.flatten().filter(|path| path.is_dir()).collect())
            .unwrap_or_default();
        matches.sort();
        matches
    }

    pub fn source_homes(&self, home: &Path) -> SourceHomes {
        let homes = self.homes(home);
        let mut source_homes = SourceHomes::default();
        match self.source {
            InputSource::Claude => source_homes.claude_config_dirs = homes,
            InputSource::Codex => source_homes.codex_homes = homes,
        }
        source_homes
    }
}

fn collapse_home(home: &Path, dir: &Path) -> String {
    match dir.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => dir.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"
        [[inputs]]
        name = "claude"
        source = "claude"
        path = "~/.claude"
    "#;

    #[test]
    fn minimal_config_takes_the_desktop_defaults() {
        let config = Config::parse(MINIMAL).unwrap();
        assert_eq!(config.interval(), cycle::DEFAULT_INTERVAL);
        assert!(matches!(config.first_backfill(), Window::History(_)));
        assert_eq!(config.credential_store, None);
    }

    #[test]
    fn invalid_configs_name_the_problem() {
        let cases = [
            ("interval_minutes = 0\n", "interval_minutes"),
            ("first_backfill = \"2w\"\n", "first_backfill"),
            ("credential_store = \"vault\"\n", "credential_store"),
            ("colour = \"blue\"\n", "colour"),
        ];
        for (prefix, expected) in cases {
            let err = Config::parse(&format!("{prefix}{MINIMAL}"))
                .unwrap_err()
                .to_string();
            assert!(err.contains(expected), "{prefix}: {err}");
        }

        let relative = MINIMAL.replace("~/.claude", ".claude");
        assert!(Config::parse(&relative).unwrap_err().0.contains("absolute"));
        let unknown_source = MINIMAL.replace("source = \"claude\"", "source = \"cursor\"");
        assert!(Config::parse(&unknown_source).is_err());
        let duplicate = format!("{MINIMAL}{MINIMAL}");
        assert!(Config::parse(&duplicate).unwrap_err().0.contains("twice"));
        assert!(Config::parse("interval_minutes = 5\ninputs = []\n").is_err());
    }

    #[test]
    fn globs_expand_to_existing_directories_on_every_call() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("alice/.claude")).unwrap();
        std::fs::write(root.path().join("not-a-home"), b"").unwrap();
        let input = Input {
            name: "users".to_string(),
            source: InputSource::Claude,
            path: format!("{}/*/.claude", root.path().display()),
        };
        assert_eq!(
            input.homes(Path::new("/unused")),
            vec![root.path().join("alice/.claude")]
        );

        std::fs::create_dir_all(root.path().join("bob/.claude")).unwrap();
        assert_eq!(input.homes(Path::new("/unused")).len(), 2);
    }

    #[test]
    fn literal_and_home_relative_paths_are_kept_before_they_exist() {
        let input = Input {
            name: "codex".to_string(),
            source: InputSource::Codex,
            path: "~/agents/codex".to_string(),
        };
        let homes = input.source_homes(Path::new("/home/u"));
        assert_eq!(
            homes.codex_homes,
            vec![PathBuf::from("/home/u/agents/codex")]
        );
        assert!(homes.claude_config_dirs.is_empty());
    }

    #[test]
    fn user_template_round_trips_and_names_extra_homes() {
        let home = Path::new("/home/u");
        let homes = SourceHomes {
            claude_config_dirs: vec![home.join(".claude"), PathBuf::from("/srv/claude")],
            codex_homes: vec![home.join(".codex")],
        };
        let config = Config::for_user(home, &homes);
        let names: Vec<_> = config.inputs.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["claude", "claude-2", "codex"]);
        assert_eq!(config.inputs[0].path, "~/.claude");
        assert_eq!(config.inputs[1].path, "/srv/claude");
        assert_eq!(config.source_homes(home), homes);

        let rendered = config.render().unwrap();
        assert!(rendered.starts_with("# Trace Flow Collector configuration"));
        assert_eq!(Config::parse(&rendered).unwrap(), config);
        assert_eq!(
            Config::parse(&Config::for_host().render().unwrap()).unwrap(),
            Config::for_host()
        );
    }
}
