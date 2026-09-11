// SPDX-License-Identifier: Apache-2.0

use collector_contracts::AgentIngestFacts;
use serde::Serialize;

/// Measure serialized fact bytes before merging into an envelope. This intentionally overcounts some
/// object-key overhead across sessions, which is safer than undercounting request bodies.
pub(crate) fn serialized_facts_bytes(facts: &AgentIngestFacts) -> usize {
    serde_json::to_vec(facts)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX / 2)
}

fn appended_size<T: Serialize>(current: usize, existing_rows: usize, row: &T) -> usize {
    current
        .saturating_add(usize::from(existing_rows > 0))
        .saturating_add(
            serde_json::to_vec(row)
                .map(|bytes| bytes.len())
                .unwrap_or(usize::MAX),
        )
}

/// Split one session's facts without dropping rows. Later chunks repeat the first message because
/// the ingest Worker derives session-level repo attribution from a message in the same envelope.
pub(crate) fn split_facts(mut facts: AgentIngestFacts, max_bytes: usize) -> Vec<AgentIngestFacts> {
    if serialized_facts_bytes(&facts) <= max_bytes {
        return vec![facts];
    }

    let max_bytes = max_bytes.max(1);
    let attribution = facts.messages.first().cloned();
    let mut chunks = Vec::new();
    let mut current = AgentIngestFacts::default();
    let empty_bytes = serialized_facts_bytes(&current);
    let mut current_bytes = empty_bytes;
    let mut original_rows = 0usize;

    macro_rules! append_rows {
        ($field:ident) => {
            for row in std::mem::take(&mut facts.$field) {
                let next_bytes = appended_size(current_bytes, current.$field.len(), &row);
                if original_rows > 0 && next_bytes > max_bytes {
                    chunks.push(std::mem::take(&mut current));
                    current_bytes = empty_bytes;
                    if let Some(message) = &attribution {
                        current_bytes = appended_size(current_bytes, 0, message);
                        current.messages.push(message.clone());
                    }
                    original_rows = 0;
                }
                current_bytes = appended_size(current_bytes, current.$field.len(), &row);
                current.$field.push(row);
                original_rows += 1;
            }
        };
    }

    append_rows!(messages);
    append_rows!(tool_events);
    append_rows!(file_events);
    append_rows!(capability_snapshots);
    append_rows!(pull_request_links);

    if original_rows > 0 {
        chunks.push(current);
    }
    if chunks.is_empty() {
        chunks.push(AgentIngestFacts::default());
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_contracts::{sample_envelope, AgentMessageFact};

    fn messages(count: usize) -> AgentIngestFacts {
        let message = sample_envelope().facts.messages[0].clone();
        AgentIngestFacts {
            messages: (0..count)
                .map(|index| AgentMessageFact {
                    vendor_message_id: Some(format!("message-{index}")),
                    turn_index: index as i64,
                    ..message.clone()
                })
                .collect(),
            ..AgentIngestFacts::default()
        }
    }

    #[test]
    fn keeps_every_original_row_in_order_across_chunks() {
        let facts = messages(12);
        let expected = facts.messages.clone();
        let max_bytes = serialized_facts_bytes(&messages(3));
        let chunks = split_facts(facts, max_bytes);

        assert!(chunks.len() > 1);
        let actual: Vec<_> = chunks
            .iter()
            .enumerate()
            .flat_map(|(index, chunk)| chunk.messages.iter().skip(usize::from(index > 0)))
            .cloned()
            .collect();
        assert_eq!(actual, expected);
        assert!(chunks
            .iter()
            .skip(1)
            .all(|chunk| chunk.messages.first() == expected.first()));
    }

    #[test]
    fn leaves_an_indivisible_oversized_fact_intact() {
        let facts = messages(1);
        let chunks = split_facts(facts.clone(), 1);
        assert_eq!(chunks, vec![facts]);
    }
}
