//! Cancellation and per-file leases for blocking search bodies.
use std::path::Path;
use std::sync::Arc;

use serde_json::json;
use tokio::sync::watch;

use crate::file_resources::FileResources;
use crate::tool_budget::{SearchReadPermit, ToolPermit};
use crate::workspace::ContainedRoots;

type SearchError = (String, String);

pub(super) struct SearchControl {
    cancelled: watch::Receiver<()>,
    runtime: tokio::runtime::Handle,
    permit: Option<Arc<ToolPermit>>,
}

impl SearchControl {
    /// The async waiter owns the sender. Dropping it signals the blocking body,
    /// including a body currently waiting for a conflicting file lease.
    pub fn new(permit: Option<Arc<ToolPermit>>) -> (watch::Sender<()>, Self) {
        let (sender, cancelled) = watch::channel(());
        (
            sender,
            Self {
                cancelled,
                runtime: tokio::runtime::Handle::current(),
                permit,
            },
        )
    }

    pub fn coordinated(&self) -> bool {
        self.permit.is_some()
    }

    pub fn check(&self) -> Result<(), SearchError> {
        if self.cancelled.has_changed().is_err() {
            Err(Self::aborted())
        } else {
            Ok(())
        }
    }

    fn aborted() -> SearchError {
        ("TOOL_ABORTED".into(), "search was cancelled".into())
    }

    pub fn read_file(
        &self,
        root: &Path,
        roots: &ContainedRoots,
        path: &Path,
        external: bool,
    ) -> Result<Option<SearchReadPermit>, SearchError> {
        self.check()?;
        let Some(permit) = &self.permit else {
            return Ok(None);
        };
        let args = json!({"path": path});
        let resources = FileResources::resolve(Some(root), roots, "Read", &args, external);
        let mut cancelled = self.cancelled.clone();
        let lease = self.runtime.block_on(async {
            tokio::select! {
                biased;
                _ = cancelled.changed() => Err(Self::aborted()),
                result = permit.acquire_search_read(resources.clone()) => {
                    result.map_err(|error| (error.code().into(), error.message()))
                }
            }
        })?;
        self.check()?;
        resources
            .validate(Some(root), roots, "Read", &args, external)
            .map_err(|error| ("TOOL_FAILED".into(), error))?;
        Ok(Some(lease))
    }
}
