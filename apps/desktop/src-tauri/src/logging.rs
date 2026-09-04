// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: tracing + a recent-errors ring. Adapted from otto-desktop's logging.rs.

//! File-backed JSON tracing plus an in-memory ring of recent warn/error events the tray menu surfaces.
//! The ring never holds secrets — events here are operational (auth class, queue errors), never the
//! credential or transcript text.

use std::{collections::VecDeque, sync::Arc, time::SystemTime};

use parking_lot::Mutex;
use tauri::{AppHandle, Runtime};
use tracing::{field::Visit, Level};
use tracing_subscriber::{
    layer::{Context, SubscriberExt},
    util::SubscriberInitExt,
    EnvFilter, Layer,
};

use crate::paths::logs_dir_path;
use crate::state::RecentError;

const RING_CAPACITY: usize = 32;

#[derive(Clone, Default)]
pub struct ErrorRing(Arc<Mutex<VecDeque<RecentError>>>);

impl ErrorRing {
    pub fn snapshot(&self, limit: usize) -> Vec<RecentError> {
        self.0.lock().iter().rev().take(limit).cloned().collect()
    }

    pub fn clear(&self) {
        self.0.lock().clear();
    }

    fn push(&self, entry: RecentError) {
        let mut guard = self.0.lock();
        if guard.len() >= RING_CAPACITY {
            guard.pop_front();
        }
        guard.push_back(entry);
    }
}

struct ErrorRingLayer {
    ring: ErrorRing,
}

struct MessageVisitor {
    message: Option<String>,
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" && self.message.is_none() {
            self.message = Some(format!("{value:?}"));
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" && self.message.is_none() {
            self.message = Some(value.to_string());
        }
    }
}

impl<S> Layer<S> for ErrorRingLayer
where
    S: tracing::Subscriber,
{
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        let level = *event.metadata().level();
        if level > Level::WARN {
            return;
        }
        let mut visitor = MessageVisitor { message: None };
        event.record(&mut visitor);
        let message = visitor
            .message
            .unwrap_or_else(|| event.metadata().target().to_string());
        self.ring.push(RecentError {
            at: SystemTime::now(),
            level: level.to_string(),
            message,
        });
    }
}

pub fn init_tracing<R: Runtime>(app: &AppHandle<R>) -> ErrorRing {
    let ring = ErrorRing::default();
    let dir = match logs_dir_path(app) {
        Ok(dir) => dir,
        Err(err) => {
            eprintln!("failed to resolve logs dir: {err}");
            return ring;
        }
    };
    let file_appender = tracing_appender::rolling::daily(&dir, "trace-flow-desktop.log");
    let env_filter =
        EnvFilter::try_from_env("TRACE_FLOW_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(file_appender)
        .with_ansi(false)
        .json();
    let ring_layer = ErrorRingLayer { ring: ring.clone() };
    if let Err(err) = tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer)
        .with(ring_layer)
        .try_init()
    {
        eprintln!("failed to install tracing subscriber: {err}");
    }
    ring
}
