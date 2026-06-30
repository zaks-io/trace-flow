// SPDX-License-Identifier: MIT

//! Ingest-time tool signal classification for derived agent read models.

use collector_contracts::enums::{
    AgentEventStatus, AgentNavigationHintCoverage, AgentNavigationKind, AgentToolErrorCategory,
    AgentToolErrorCoverage,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolErrorClassification {
    pub category: AgentToolErrorCategory,
    pub coverage: AgentToolErrorCoverage,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolNavigationClassification {
    pub is_navigation: bool,
    pub kind: AgentNavigationKind,
    pub hint_coverage: AgentNavigationHintCoverage,
    pub path_hint: String,
    pub pattern_hint: String,
}

impl Default for ToolNavigationClassification {
    fn default() -> Self {
        Self {
            is_navigation: false,
            kind: AgentNavigationKind::None,
            hint_coverage: AgentNavigationHintCoverage::NotApplicable,
            path_hint: String::new(),
            pattern_hint: String::new(),
        }
    }
}

pub fn classify_tool_error(
    status: AgentEventStatus,
    error_text: Option<&str>,
) -> ToolErrorClassification {
    if status != AgentEventStatus::Failure {
        return ToolErrorClassification {
            category: AgentToolErrorCategory::Unknown,
            coverage: AgentToolErrorCoverage::NotApplicable,
        };
    }

    let Some(text) = error_text.map(str::trim).filter(|text| !text.is_empty()) else {
        return ToolErrorClassification {
            category: AgentToolErrorCategory::Unknown,
            coverage: AgentToolErrorCoverage::Unknown,
        };
    };

    ToolErrorClassification {
        category: error_category(text),
        coverage: AgentToolErrorCoverage::Classified,
    }
}

fn error_category(text: &str) -> AgentToolErrorCategory {
    let t = text.to_ascii_lowercase();
    if any(
        &t,
        &[
            "no such file or directory",
            "enoent",
            "cannot find file",
            "file not found",
        ],
    ) {
        AgentToolErrorCategory::MissingFile
    } else if any(&t, &["is a directory", "eisdir", "cannot read directory"]) {
        AgentToolErrorCategory::ReadDirectory
    } else if any(
        &t,
        &[
            "must read",
            "read it first",
            "has not been read",
            "read before edit",
        ],
    ) {
        AgentToolErrorCategory::EditBeforeRead
    } else if any(
        &t,
        &["modified since", "stale", "file changed", "out of date"],
    ) {
        AgentToolErrorCategory::StaleFileBeforeEdit
    } else if any(
        &t,
        &[
            "schema validation",
            "json schema",
            "invalid schema",
            "validation failed",
        ],
    ) {
        AgentToolErrorCategory::ExternalSchemaValidation
    } else if any(
        &t,
        &[
            "command not found",
            "cannot find module",
            "module not found",
            "no such command",
        ],
    ) {
        AgentToolErrorCategory::RuntimeEnvMismatch
    } else if any(
        &t,
        &[
            "invalid arguments",
            "invalid input",
            "missing required",
            "expected type",
        ],
    ) {
        AgentToolErrorCategory::ToolInputValidation
    } else if any(
        &t,
        &[
            "user rejected",
            "not approved",
            "approval denied",
            "policy violation",
        ],
    ) {
        AgentToolErrorCategory::HumanOrPolicyRejection
    } else if any(
        &t,
        &[
            "tool not found",
            "unknown tool",
            "no such tool",
            "invalid tool name",
        ],
    ) {
        AgentToolErrorCategory::WrongToolName
    } else if any(
        &t,
        &["too large", "exceeds maximum", "maximum read", "oversized"],
    ) {
        AgentToolErrorCategory::OversizedRead
    } else {
        AgentToolErrorCategory::Other
    }
}

fn any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

pub fn classify_navigation(command: Option<&str>) -> ToolNavigationClassification {
    let Some(command) = command.map(str::trim).filter(|text| !text.is_empty()) else {
        return ToolNavigationClassification::default();
    };
    let tokens = command_tokens(command);
    let Some(program) = tokens
        .first()
        .map(|token| basename(token).to_ascii_lowercase())
    else {
        return ToolNavigationClassification {
            hint_coverage: AgentNavigationHintCoverage::Unknown,
            ..ToolNavigationClassification::default()
        };
    };

    match program.as_str() {
        "rg" => search_command(&tokens, &["-e", "--regexp"], &["-g", "--glob", "-t", "-T"]),
        "grep" => search_command(&tokens, &["-e", "--regexp"], &["-f", "--file"]),
        "find" => find_command(&tokens),
        "sed" => sed_command(&tokens),
        "nl" | "cat" => path_command(&tokens, AgentNavigationKind::FileRead),
        "ls" => path_command(&tokens, AgentNavigationKind::DirectoryList),
        "cd" => path_command(&tokens, AgentNavigationKind::DirectoryChange),
        _ => unknown_navigation(),
    }
}

fn unknown_navigation() -> ToolNavigationClassification {
    ToolNavigationClassification {
        hint_coverage: AgentNavigationHintCoverage::Unknown,
        ..ToolNavigationClassification::default()
    }
}

fn search_command(
    tokens: &[String],
    pattern_options: &[&str],
    value_options: &[&str],
) -> ToolNavigationClassification {
    let mut pattern = option_value(tokens, pattern_options).unwrap_or_default();
    let mut positionals = positionals(tokens, &[pattern_options, value_options].concat());
    if pattern.is_empty() && !positionals.is_empty() {
        pattern = positionals.remove(0);
    }
    ToolNavigationClassification {
        is_navigation: true,
        kind: AgentNavigationKind::Search,
        hint_coverage: AgentNavigationHintCoverage::Structured,
        path_hint: positionals.first().cloned().unwrap_or_default(),
        pattern_hint: pattern,
    }
}

fn find_command(tokens: &[String]) -> ToolNavigationClassification {
    let path_hint = find_root(tokens).unwrap_or_else(|| ".".to_string());
    ToolNavigationClassification {
        is_navigation: true,
        kind: AgentNavigationKind::Search,
        hint_coverage: AgentNavigationHintCoverage::Structured,
        path_hint,
        pattern_hint: option_value(tokens, &["-name", "-iname", "-path", "-regex"])
            .unwrap_or_default(),
    }
}

fn find_root(tokens: &[String]) -> Option<String> {
    let mut after_separator = false;
    for token in tokens.iter().skip(1) {
        if token == "--" {
            after_separator = true;
            continue;
        }
        if !after_separator && matches!(token.as_str(), "-H" | "-L" | "-P") {
            continue;
        }
        if !after_separator && (token.starts_with('-') || matches!(token.as_str(), "(" | "!")) {
            break;
        }
        return Some(token.clone());
    }
    None
}

fn sed_command(tokens: &[String]) -> ToolNavigationClassification {
    let positionals = positionals(tokens, &["-e", "-f"]);
    let path_hint = positionals.last().cloned().unwrap_or_default();
    let pattern_hint = positionals
        .iter()
        .find(|arg| *arg != &path_hint)
        .cloned()
        .unwrap_or_else(|| option_value(tokens, &["-e"]).unwrap_or_default());
    ToolNavigationClassification {
        is_navigation: true,
        kind: AgentNavigationKind::FileRead,
        hint_coverage: AgentNavigationHintCoverage::Structured,
        path_hint,
        pattern_hint,
    }
}

fn path_command(tokens: &[String], kind: AgentNavigationKind) -> ToolNavigationClassification {
    let positionals = positionals(tokens, &[]);
    ToolNavigationClassification {
        is_navigation: true,
        kind,
        hint_coverage: AgentNavigationHintCoverage::Structured,
        path_hint: positionals.first().cloned().unwrap_or_default(),
        pattern_hint: String::new(),
    }
}

fn command_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for c in command.chars() {
        if escaped {
            current.push(c);
            escaped = false;
            continue;
        }
        if quote != Some('\'') && c == '\\' {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                current.push(c);
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            ' ' | '\t' | '\n' | '\r' => push_token(&mut tokens, &mut current),
            '|' | ';' | '&' => {
                push_token(&mut tokens, &mut current);
                break;
            }
            _ => current.push(c),
        }
    }
    push_token(&mut tokens, &mut current);
    tokens
}

fn push_token(tokens: &mut Vec<String>, current: &mut String) {
    if !current.is_empty() {
        tokens.push(std::mem::take(current));
    }
}

fn basename(token: &str) -> &str {
    token.rsplit(['/', '\\']).next().unwrap_or(token)
}

fn positionals(tokens: &[String], value_options: &[&str]) -> Vec<String> {
    let mut args = Vec::new();
    let mut skip_next = false;
    for token in tokens.iter().skip(1) {
        if skip_next {
            skip_next = false;
            continue;
        }
        if token == "--" {
            continue;
        }
        if value_options.contains(&token.as_str()) {
            skip_next = true;
            continue;
        }
        if token.starts_with('-') {
            continue;
        }
        args.push(token.clone());
    }
    args
}

fn option_value(tokens: &[String], names: &[&str]) -> Option<String> {
    for (index, token) in tokens.iter().enumerate().skip(1) {
        if names.contains(&token.as_str()) {
            return tokens.get(index + 1).cloned();
        }
        for name in names {
            let prefix = format!("{name}=");
            if let Some(value) = token.strip_prefix(&prefix) {
                return Some(value.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_required_error_categories() {
        for (text, category) in [
            (
                "No such file or directory",
                AgentToolErrorCategory::MissingFile,
            ),
            (
                "EISDIR: is a directory",
                AgentToolErrorCategory::ReadDirectory,
            ),
            (
                "File has not been read yet",
                AgentToolErrorCategory::EditBeforeRead,
            ),
            (
                "File modified since last read",
                AgentToolErrorCategory::StaleFileBeforeEdit,
            ),
            (
                "JSON schema validation failed",
                AgentToolErrorCategory::ExternalSchemaValidation,
            ),
            (
                "bash: bun: command not found",
                AgentToolErrorCategory::RuntimeEnvMismatch,
            ),
            (
                "missing required field `body`",
                AgentToolErrorCategory::ToolInputValidation,
            ),
            (
                "user rejected the tool call",
                AgentToolErrorCategory::HumanOrPolicyRejection,
            ),
            (
                "unknown tool: get_issues",
                AgentToolErrorCategory::WrongToolName,
            ),
            (
                "file too large to read",
                AgentToolErrorCategory::OversizedRead,
            ),
            ("something else broke", AgentToolErrorCategory::Other),
        ] {
            let c = classify_tool_error(AgentEventStatus::Failure, Some(text));
            assert_eq!(c.category, category, "{text}");
            assert_eq!(c.coverage, AgentToolErrorCoverage::Classified);
        }
    }

    #[test]
    fn non_failures_and_empty_failures_preserve_coverage() {
        let success = classify_tool_error(AgentEventStatus::Success, Some("ignored"));
        assert_eq!(success.category, AgentToolErrorCategory::Unknown);
        assert_eq!(success.coverage, AgentToolErrorCoverage::NotApplicable);

        let unknown = classify_tool_error(AgentEventStatus::Failure, Some("   "));
        assert_eq!(unknown.category, AgentToolErrorCategory::Unknown);
        assert_eq!(unknown.coverage, AgentToolErrorCoverage::Unknown);
    }

    #[test]
    fn recognizes_required_navigation_commands() {
        for (cmd, kind, path, pattern) in [
            (
                "rg -n \"agent tool\" packages",
                AgentNavigationKind::Search,
                "packages",
                "agent tool",
            ),
            (
                "grep -R error src",
                AgentNavigationKind::Search,
                "src",
                "error",
            ),
            (
                "find . -name '*.rs'",
                AgentNavigationKind::Search,
                ".",
                "*.rs",
            ),
            (
                "sed -n '1,120p' src/main.rs",
                AgentNavigationKind::FileRead,
                "src/main.rs",
                "1,120p",
            ),
            (
                "nl -ba src/lib.rs",
                AgentNavigationKind::FileRead,
                "src/lib.rs",
                "",
            ),
            (
                "ls -la apps",
                AgentNavigationKind::DirectoryList,
                "apps",
                "",
            ),
            (
                "cat ./README.md",
                AgentNavigationKind::FileRead,
                "./README.md",
                "",
            ),
            (
                "cd apps/web",
                AgentNavigationKind::DirectoryChange,
                "apps/web",
                "",
            ),
        ] {
            let c = classify_navigation(Some(cmd));
            assert!(c.is_navigation, "{cmd}");
            assert_eq!(c.kind, kind, "{cmd}");
            assert_eq!(c.hint_coverage, AgentNavigationHintCoverage::Structured);
            assert_eq!(c.path_hint, path, "{cmd}");
            assert_eq!(c.pattern_hint, pattern, "{cmd}");
        }
    }

    #[test]
    fn ignores_shell_suffixes_after_the_first_command() {
        let c = classify_navigation(Some("rg foo src | head"));
        assert!(c.is_navigation);
        assert_eq!(c.path_hint, "src");
        assert_eq!(c.pattern_hint, "foo");
    }

    #[test]
    fn find_preserves_default_root_and_skips_predicate_values() {
        let default_root = classify_navigation(Some("find -name '*.rs'"));
        assert!(default_root.is_navigation);
        assert_eq!(default_root.path_hint, ".");
        assert_eq!(default_root.pattern_hint, "*.rs");

        let maxdepth = classify_navigation(Some("find -maxdepth 2 -name '*.rs'"));
        assert!(maxdepth.is_navigation);
        assert_eq!(maxdepth.path_hint, ".");
        assert_eq!(maxdepth.pattern_hint, "*.rs");

        let explicit_root = classify_navigation(Some("find -L packages -maxdepth 2 -name '*.rs'"));
        assert!(explicit_root.is_navigation);
        assert_eq!(explicit_root.path_hint, "packages");
        assert_eq!(explicit_root.pattern_hint, "*.rs");
    }

    #[test]
    fn unsupported_commands_keep_unknown_navigation_coverage() {
        let c = classify_navigation(Some("python scripts/sync.py"));
        assert!(!c.is_navigation);
        assert_eq!(c.kind, AgentNavigationKind::None);
        assert_eq!(c.hint_coverage, AgentNavigationHintCoverage::Unknown);
    }
}
