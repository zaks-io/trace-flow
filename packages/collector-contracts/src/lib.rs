//! Wire contract types for the Trace Flow agent Collector ingest envelope.
//!
//! This crate is the Rust mirror of the envelope side of `packages/types/src/agent-ingest.ts`.
//! `serde(rename_all = "snake_case")` on the enums and snake_case struct fields keep the JSON
//! byte-identical across both languages. `fixtures/agent-envelope.sample.json` is the shared
//! contract fixture; a rename on either side fails its own round-trip test.
//!
//! The queue-message side (`AgentIngestQueueMessage`) is TS-only — it is produced by the ingest
//! Worker and read by the consumer, neither of which is Rust — so it is intentionally not mirrored.

pub mod enums;
pub mod envelope;
pub mod facts;
pub mod sample;

pub use enums::{
    AgentCapabilityKind, AgentEventStatus, AgentFileOperation, AgentMessageRole,
    AgentNavigationHintCoverage, AgentNavigationKind, AgentSource, AgentToolErrorCategory,
    AgentToolErrorCoverage, CacheCoverage, PullRequestLinkConfidence, PullRequestLinkEvidence,
    RepoSource, TokenCoverage,
};
pub use envelope::{
    AgentIngestBatch, AgentIngestEnvelope, AgentIngestFacts, RawSessionBundle,
    RawSessionBundleManifest,
};
pub use facts::{
    AgentCapabilitySnapshotFact, AgentFileEventFact, AgentMessageFact, AgentPullRequestLinkFact,
    AgentToolEventFact,
};
pub use sample::sample_envelope;
