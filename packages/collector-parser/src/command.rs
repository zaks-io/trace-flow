// SPDX-License-Identifier: Apache-2.0
// Adapted from otto-parser/src/parser/derive_facts.rs `command_family` (~/src/otto, 2026-05-25).
// Diverged deliberately: otto emits a *two-part* family ("git push", "npm install") from a hardcoded
// allowlist of programs — an invented taxonomy the Trace Flow ADR never defines and explicitly avoids.
// Trace Flow splits a command into program + subcommand and sets `command_family = command_program`
// (the documented program-as-family resolution), so the failure leaderboard groups by program with no
// curated family list to drift. The contract sample (`collector-contracts/src/sample.rs`) pins the
// shape: `git push origin HEAD` => program `git`, subcommand `push`, family `git`.
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Command classification for Tool Event facts. `classify_command` turns a raw shell command into the
//! `command_program` / `command_subcommand` / `command_family` triple on `AgentToolEventFact`. It is
//! mechanical argv parsing, not a curated taxonomy: `family == program`.

/// The program/subcommand/family split for one shell command. All three are `String` (never
/// `Option`) to match the `AgentToolEventFact` columns; an empty command yields three empty strings.
/// `family` is always equal to `program` — the program-as-family resolution — so the leaderboard
/// groups by program without an invented family list.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CommandClassification {
    pub program: String,
    pub subcommand: String,
    pub family: String,
}

/// Returns the trailing path component of a token, so `/usr/bin/git` and `git` both classify as
/// `git`. A token with no separator is returned unchanged.
fn program_name(token: &str) -> &str {
    token.rsplit(['/', '\\']).next().unwrap_or(token)
}

/// Classifies a raw shell command into program / subcommand / family.
///
/// `program` is the basename of the first whitespace-delimited token; `family` equals it. `subcommand`
/// is the second token only when it reads as a verb rather than a flag or a path (it does not start
/// with `-` and contains no path separator), so `git push` yields `push` while `ls -la` and
/// `cat ./x` yield no subcommand. Shell wrappers and leading `KEY=value` env assignments are **not**
/// unwrapped here — that is a deliberate scope boundary (a future enrichment), kept out so this stays
/// mechanical parsing rather than command-shape heuristics.
pub fn classify_command(command: &str) -> CommandClassification {
    let mut tokens = command.split_whitespace();
    let Some(first) = tokens.next() else {
        return CommandClassification::default();
    };
    let program = program_name(first).to_string();
    let subcommand = match tokens.next() {
        Some(second) if !second.starts_with('-') && !second.contains(['/', '\\']) => {
            second.to_string()
        }
        _ => String::new(),
    };
    CommandClassification {
        family: program.clone(),
        program,
        subcommand,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_contract_sample() {
        // `collector-contracts/src/sample.rs`: git push origin HEAD => git / push / git.
        let c = classify_command("git push origin HEAD");
        assert_eq!(c.program, "git");
        assert_eq!(c.subcommand, "push");
        assert_eq!(c.family, "git");
    }

    #[test]
    fn family_always_equals_program() {
        for cmd in [
            "npm install",
            "cargo test --workspace",
            "ls",
            "rm -rf build",
        ] {
            let c = classify_command(cmd);
            assert_eq!(
                c.family, c.program,
                "family must mirror program for `{cmd}`"
            );
        }
    }

    #[test]
    fn strips_a_leading_path_to_the_basename() {
        let c = classify_command("/usr/local/bin/node script.js");
        assert_eq!(c.program, "node");
        assert_eq!(c.family, "node");
        // Known limitation of mechanical parsing: `script.js` is semantically an argument, but it has
        // no separator and no leading `-`, so the heuristic classifies it as the subcommand.
        assert_eq!(c.subcommand, "script.js");
    }

    #[test]
    fn a_flag_second_token_is_not_a_subcommand() {
        let c = classify_command("ls -la");
        assert_eq!(c.program, "ls");
        assert_eq!(c.subcommand, "");
    }

    #[test]
    fn a_path_second_token_is_not_a_subcommand() {
        let c = classify_command("cat ./src/main.rs");
        assert_eq!(c.program, "cat");
        assert_eq!(c.subcommand, "");
    }

    #[test]
    fn single_token_command_has_no_subcommand() {
        let c = classify_command("pwd");
        assert_eq!(c.program, "pwd");
        assert_eq!(c.subcommand, "");
        assert_eq!(c.family, "pwd");
    }

    #[test]
    fn empty_command_yields_all_empty() {
        assert_eq!(classify_command(""), CommandClassification::default());
        assert_eq!(classify_command("   "), CommandClassification::default());
    }

    #[test]
    fn collapses_extra_whitespace() {
        let c = classify_command("  git   status  ");
        assert_eq!(c.program, "git");
        assert_eq!(c.subcommand, "status");
    }

    #[test]
    fn env_prefix_is_not_unwrapped_by_design() {
        // Documented scope boundary: a leading KEY=value is treated as the program, not stripped. The
        // future enrichment that unwraps wrappers/env will change this; the test pins today's behavior.
        let c = classify_command("NODE_ENV=production npm run build");
        assert_eq!(c.program, "NODE_ENV=production");
        assert_eq!(c.subcommand, "npm");
    }
}
