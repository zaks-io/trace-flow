//! Regenerates `fixtures/agent-envelope.sample.json` from the canonical `sample_envelope()`.
//! Run from the repo root: `cargo run -p collector-contracts --example dump_sample`.

fn main() {
    let json = serde_json::to_string_pretty(&collector_contracts::sample_envelope())
        .expect("sample envelope serializes");
    println!("{json}");
}
