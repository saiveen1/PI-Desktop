//! The derived physical index for a session transcript.
//!
//! Layout offsets are disposable. They are reused only while the transcript's
//! file identity still matches, and every cache failure falls back to a scan.

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use super::{sniff_line_kind, swap_into_place, transcript_path};

const LAYOUT_CACHE_MIN_LEN: u64 = 2 * 1024 * 1024;
const LAYOUT_CACHE_MAX_LAG: u64 = 4 * 1024 * 1024;
const LAYOUT_CACHE_MAGIC: &str = "PI-DESKTOP-TRANSCRIPT-LAYOUT";
const LAYOUT_CACHE_VERSION: &str = "5";

#[cfg(test)]
thread_local! {
    pub(super) static SCANNED_LINES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// A stable identity available on filesystems that expose one.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub enum FileIdentity {
    Available {
        platform: &'static str,
        volume_id: u64,
        file_id: [u8; 16],
    },
    #[default]
    Unavailable,
}

impl FileIdentity {
    fn is_available(&self) -> bool {
        matches!(self, Self::Available { .. })
    }

    fn write_tokens(&self, writer: &mut impl Write) -> std::io::Result<()> {
        match self {
            Self::Available {
                platform,
                volume_id,
                file_id,
            } => writeln!(writer, "{platform} {volume_id:x} {}", hex::encode(file_id)),
            Self::Unavailable => Err(std::io::Error::other("file identity is unavailable")),
        }
    }

    fn from_tokens(platform: &str, volume_id: &str, file_id: &str) -> Option<Self> {
        let expected_platform = if cfg!(unix) {
            "unix"
        } else if cfg!(windows) {
            "windows"
        } else {
            return None;
        };
        if platform != expected_platform {
            return None;
        }
        let volume_id = u64::from_str_radix(volume_id, 16).ok()?;
        let bytes = hex::decode(file_id).ok()?;
        let file_id: [u8; 16] = bytes.try_into().ok()?;
        Some(Self::Available {
            platform: expected_platform,
            volume_id,
            file_id,
        })
    }
}

/// Physical layout of one transcript file: the byte offset of every message
/// and compaction line, plus the file prefix those offsets describe.
#[derive(Debug, Default, Clone)]
pub struct TranscriptLayout {
    /// Byte offset of each message line, in file order.
    pub message_offsets: Vec<u64>,
    /// Parsed identities parallel to message offsets. Invalid rows keep None so
    /// point reads still expose their decoding errors instead of hiding them.
    pub(super) message_ids: Vec<Option<String>>,
    /// Physical marker rows; canonical order keeps the first slot and last payload per ID.
    pub(super) marker_rows: Vec<usize>,
    pub(super) boundary: OnceLock<Option<ContextBoundary>>,
    /// Sorted physical positions of top-level user messages.
    pub(super) user_message_positions: Vec<usize>,
    /// Byte offset of each compaction line, in file order.
    pub compaction_offsets: Vec<u64>,
    /// Byte offset of each append-only tool review state line.
    pub tool_review_state_offsets: Vec<u64>,
    /// Byte length of the file prefix this layout describes.
    pub file_len: u64,
    pub(crate) identity: FileIdentity,
    pub(super) modification_stamp: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ContextBoundary {
    pub id: String,
    pub excluded_ids: HashSet<String>,
}

#[derive(serde::Deserialize)]
struct MessageIdentity {
    id: String,
    role: Option<String>,
    meta: Option<MessageAncestry>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageAncestry {
    parent_tool_call_id: Option<serde::de::IgnoredAny>,
    nested_parent_tool_call_id: Option<serde::de::IgnoredAny>,
    context_override: Option<serde::de::IgnoredAny>,
}

#[derive(serde::Deserialize)]
struct MessageId {
    id: String,
}

pub(super) fn modification_stamp(_path: &Path, metadata: &fs::Metadata) -> Option<String> {
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(format!(
            "{modified}:{}:{}",
            metadata.ctime(),
            metadata.ctime_nsec()
        ))
    }
    #[cfg(windows)]
    {
        let changed = super::binary_integrity::change_time(&File::open(_path).ok()?).ok()?;
        Some(format!("{modified}:{changed}"))
    }
    #[cfg(not(any(unix, windows)))]
    Some(modified.to_string())
}

impl TranscriptLayout {
    /// Physical message-line count. Window offsets use this coordinate space,
    /// not the deduplicated message positions.
    pub fn message_count(&self) -> usize {
        self.message_offsets.len()
    }

    pub(crate) fn context_boundary(&self) -> Option<&ContextBoundary> {
        self.boundary
            .get_or_init(|| {
                if self.marker_rows.is_empty() {
                    return None;
                }
                let mut candidates: HashMap<&str, (usize, bool)> = self
                    .marker_rows
                    .iter()
                    .filter_map(|&i| self.message_ids[i].as_deref().map(|id| (id, (i, false))))
                    .collect();
                for (i, id) in self.message_ids.iter().enumerate() {
                    if let Some((first, marked)) =
                        id.as_deref().and_then(|id| candidates.get_mut(id))
                    {
                        *first = (*first).min(i);
                        *marked = self.marker_rows.binary_search(&i).is_ok();
                    }
                }
                let (id, (start, _)) = candidates
                    .into_iter()
                    .filter(|(_, (_, marked))| *marked)
                    .max_by_key(|(_, (first, _))| *first)?;
                Some(ContextBoundary {
                    id: id.to_owned(),
                    excluded_ids: self.message_ids[..start]
                        .iter()
                        .flatten()
                        .cloned()
                        .collect(),
                })
            })
            .as_ref()
    }

    pub(crate) fn previous_user_message(&self, before: usize) -> Option<usize> {
        let positions = &self.user_message_positions;
        let end = positions.partition_point(|&position| position < before);
        end.checked_sub(1).map(|index| positions[index])
    }

    fn empty(identity: FileIdentity) -> Self {
        Self {
            identity,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct LayoutKey {
    data_dir: PathBuf,
    session_id: String,
}

type LayoutCache = Mutex<HashMap<LayoutKey, Arc<TranscriptLayout>>>;
static TRANSCRIPT_LAYOUTS: OnceLock<LayoutCache> = OnceLock::new();

fn layout_cache() -> &'static LayoutCache {
    TRANSCRIPT_LAYOUTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn layout_key(data_dir: &Path, session_id: &str) -> LayoutKey {
    LayoutKey {
        data_dir: data_dir.to_path_buf(),
        session_id: session_id.to_string(),
    }
}

/// Extend a cached prefix's generation proof only for an append made by this
/// writer to the generation it already described. Unknown mutations force a
/// rescan, even when they also grow the file.
pub(super) fn note_append(path: &Path, before: &fs::Metadata, before_stamp: Option<&str>) {
    let Some((data_dir, session_id)) = path.parent().and_then(Path::parent).zip(
        path.file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".jsonl")),
    ) else {
        return;
    };
    let Ok(mut guard) = layout_cache().lock() else {
        return;
    };
    let Some(layout) = guard.get_mut(&layout_key(data_dir, session_id)) else {
        return;
    };
    let layout = Arc::make_mut(layout);
    let after = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            layout.modification_stamp = None;
            tracing::warn!(%error, "failed to refresh transcript layout generation after append");
            return;
        }
    };
    if before_stamp.is_some()
        && layout.modification_stamp.as_deref() == before_stamp
        && layout.identity == file_identity(path, before)
        && layout.identity == file_identity(path, &after)
    {
        layout.modification_stamp = modification_stamp(path, &after);
    } else {
        layout.modification_stamp = None;
    }
}

fn layout_cache_path(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    Ok(transcript_path(data_dir, session_id)?.with_extension("jsonl.layout"))
}

/// Return an up-to-date layout, reusing the process cache or a validated disk
/// cache and scanning only the appended tail.
pub(crate) fn session_layout(data_dir: &Path, session_id: &str) -> Result<Arc<TranscriptLayout>> {
    let key = layout_key(data_dir, session_id);
    let cached = layout_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.get(&key).cloned())
        .unwrap_or_default();
    let layout = refresh_shared_layout(data_dir, session_id, cached)?;
    if let Ok(mut guard) = layout_cache().lock() {
        guard.insert(key, layout.clone());
    }
    Ok(layout)
}

/// Remove both derived cache layers after a rewrite or session deletion.
/// Cleanup failure is diagnostic only; file identity still prevents the stale
/// disk cache from being trusted on the next read.
pub(crate) fn invalidate(data_dir: &Path, session_id: &str) {
    if let Ok(mut guard) = layout_cache().lock() {
        guard.remove(&layout_key(data_dir, session_id));
    }
    let mut paths = Vec::new();
    if let Ok(cache) = layout_cache_path(data_dir, session_id) {
        paths.push(cache.with_extension("layout.tmp"));
        paths.push(cache);
    }
    for path in paths {
        if let Err(error) = fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(%error, "failed to invalidate transcript layout cache");
            }
        }
    }
}

/// A boundary failure means an indexed offset does not point at the expected
/// JSONL line. It is distinct from transcript I/O or decoding failures so the
/// common read path can rebuild once and retry.
#[derive(Debug, thiserror::Error)]
#[error("transcript layout boundary is invalid")]
pub(crate) struct InvalidLayoutBoundary;

pub(crate) fn invalid_boundary() -> anyhow::Error {
    InvalidLayoutBoundary.into()
}

/// Rebuild once after an indexed read detects a stale/corrupt boundary. The
/// retry always bypasses the disk cache and callers recompute their selection
/// from the rebuilt message count.
pub(crate) fn with_layout_recovery<T>(
    data_dir: &Path,
    session_id: &str,
    mut operation: impl FnMut(&TranscriptLayout) -> Result<T>,
) -> Result<T> {
    let first = session_layout(data_dir, session_id)?;
    match operation(&first) {
        Ok(value) => Ok(value),
        Err(error) if error.is::<InvalidLayoutBoundary>() => {
            invalidate(data_dir, session_id);
            let rebuilt = Arc::new(scan_current_file(data_dir, session_id)?);
            cache_rebuilt_layout(data_dir, session_id, &rebuilt);
            match operation(&rebuilt) {
                Err(error) if error.is::<InvalidLayoutBoundary>() => {
                    Err(error.context("transcript layout remained invalid after one full rebuild"))
                }
                result => result,
            }
        }
        Err(error) => Err(error),
    }
}

fn cache_rebuilt_layout(data_dir: &Path, session_id: &str, layout: &Arc<TranscriptLayout>) {
    if let Ok(mut guard) = layout_cache().lock() {
        guard.insert(layout_key(data_dir, session_id), layout.clone());
    }
    if let Err(error) = store_layout_cache(data_dir, session_id, layout) {
        tracing::warn!(%error, "failed to persist rebuilt transcript layout cache");
    }
}

#[cfg(test)]
pub fn refresh_layout(
    data_dir: &Path,
    session_id: &str,
    base: TranscriptLayout,
) -> Result<TranscriptLayout> {
    refresh_shared_layout(data_dir, session_id, Arc::new(base)).map(Arc::unwrap_or_clone)
}

/// Refresh the supplied layout only after validating its file identity.
fn refresh_shared_layout(
    data_dir: &Path,
    session_id: &str,
    base: Arc<TranscriptLayout>,
) -> Result<Arc<TranscriptLayout>> {
    let path = transcript_path(data_dir, session_id)?;
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Arc::default());
        }
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    };
    refresh_with_identity(
        data_dir,
        session_id,
        base,
        metadata.len(),
        file_identity(&path, &metadata),
    )
}

fn refresh_with_identity(
    data_dir: &Path,
    session_id: &str,
    base: Arc<TranscriptLayout>,
    length: u64,
    identity: FileIdentity,
) -> Result<Arc<TranscriptLayout>> {
    let path = transcript_path(data_dir, session_id)?;
    let stamp = modification_stamp(&path, &fs::metadata(&path)?);
    let mut base = if identity.is_available()
        && base.identity == identity
        && base.file_len <= length
        && stamp.is_some()
        && base.modification_stamp == stamp
    {
        base
    } else {
        Arc::new(TranscriptLayout::empty(identity.clone()))
    };

    if !identity.is_available() {
        // Without a reliable identity, no existing offsets can be trusted.
        base = Arc::new(TranscriptLayout::empty(identity.clone()));
    } else if base.file_len == 0 {
        base = load_layout_cache(data_dir, session_id, &identity, length)?
            .map(Arc::new)
            .unwrap_or_else(|| Arc::new(TranscriptLayout::empty(identity.clone())));
    }

    if length == base.file_len {
        if stamp.is_some() && base.modification_stamp == stamp {
            return Ok(base);
        }
        base = Arc::new(TranscriptLayout::empty(identity));
    }
    let base_len = base.file_len;
    let layout = scan_layout(&path, Arc::unwrap_or_clone(base))?;
    if base_len == 0 || layout.file_len.saturating_sub(base_len) >= LAYOUT_CACHE_MAX_LAG {
        if let Err(error) = store_layout_cache(data_dir, session_id, &layout) {
            tracing::warn!(%error, "failed to persist transcript layout cache");
        }
    }
    Ok(Arc::new(layout))
}

fn scan_current_file(data_dir: &Path, session_id: &str) -> Result<TranscriptLayout> {
    let path = transcript_path(data_dir, session_id)?;
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TranscriptLayout::default())
        }
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    };
    let identity = file_identity(&path, &metadata);
    scan_layout(&path, TranscriptLayout::empty(identity))
}

/// Scan from the known complete-line prefix to EOF, extending the offsets.
fn scan_layout(path: &Path, mut layout: TranscriptLayout) -> Result<TranscriptLayout> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TranscriptLayout::default())
        }
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let mut offset = layout.file_len;
    if offset > 0 {
        file.seek(SeekFrom::Start(offset))
            .with_context(|| format!("seek {}", path.display()))?;
    }
    let mut reader = BufReader::new(file);
    let mut raw = Vec::new();
    loop {
        raw.clear();
        let read = reader.read_until(b'\n', &mut raw)?;
        if read == 0 {
            break;
        }
        #[cfg(test)]
        SCANNED_LINES.with(|lines| lines.set(lines.get() + 1));
        // A torn append is excluded until its newline arrives.
        if !raw.ends_with(b"\n") {
            break;
        }
        // Preserve the readable prefix and suffix when a completed append
        // contains bytes from a character that was torn during a crash.
        let line = String::from_utf8_lossy(&raw);
        match sniff_line_kind(line.trim_end()) {
            Some("message") => {
                let id = match serde_json::from_str::<MessageIdentity>(&line) {
                    Ok(identity) => {
                        if identity.role.as_deref() == Some("user")
                            && identity.meta.as_ref().is_none_or(|meta| {
                                meta.parent_tool_call_id.is_none()
                                    && meta.nested_parent_tool_call_id.is_none()
                            })
                        {
                            layout.user_message_positions.push(layout.message_count());
                            if identity
                                .meta
                                .as_ref()
                                .is_some_and(|m| m.context_override.is_some())
                                && serde_json::from_str::<super::MessageRecord>(&line)
                                    .is_ok_and(|r| r.marks_context_boundary())
                            {
                                layout.marker_rows.push(layout.message_count());
                            }
                        }
                        Some(identity.id)
                    }
                    // Historical rows can have arbitrary metadata. Preserve
                    // their ID index even when ancestry could not be decoded.
                    Err(_) => serde_json::from_str::<MessageId>(&line)
                        .ok()
                        .map(|value| value.id),
                };
                // Normal appends cannot move the logical prefix. Recompute only on
                // a new marker or a replacement for the current winner.
                if layout.marker_rows.last() == Some(&layout.message_count())
                    || layout
                        .boundary
                        .get()
                        .and_then(Option::as_ref)
                        .is_some_and(|b| Some(&b.id) == id.as_ref())
                {
                    layout.boundary.take();
                }
                layout.message_offsets.push(offset);
                layout.message_ids.push(id);
            }
            Some("compaction") => layout.compaction_offsets.push(offset),
            Some("tool_review_state") => layout.tool_review_state_offsets.push(offset),
            _ => {}
        }
        offset += read as u64;
        if raw.capacity() > 1024 * 1024 {
            raw = Vec::new();
        }
    }
    layout.file_len = offset;
    layout.modification_stamp = modification_stamp(path, &reader.get_ref().metadata()?);
    Ok(layout)
}

fn load_layout_cache(
    data_dir: &Path,
    session_id: &str,
    identity: &FileIdentity,
    current_len: u64,
) -> Result<Option<TranscriptLayout>> {
    if current_len < LAYOUT_CACHE_MIN_LEN {
        return Ok(None);
    }
    let cache_path = layout_cache_path(data_dir, session_id)?;
    let raw = match fs::read_to_string(&cache_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            tracing::warn!(%error, "failed to read transcript layout cache");
            return Ok(None);
        }
    };
    let mut tokens = raw.split_ascii_whitespace();
    if tokens.next() != Some(LAYOUT_CACHE_MAGIC) || tokens.next() != Some(LAYOUT_CACHE_VERSION) {
        return Ok(None);
    }
    let (Some(platform), Some(volume), Some(file_id)) =
        (tokens.next(), tokens.next(), tokens.next())
    else {
        return Ok(None);
    };
    let Some(cached_identity) = FileIdentity::from_tokens(platform, volume, file_id) else {
        return Ok(None);
    };
    if &cached_identity != identity {
        return Ok(None);
    }
    let Some(file_len) = tokens.next().and_then(|token| token.parse::<u64>().ok()) else {
        return Ok(None);
    };
    if file_len < LAYOUT_CACHE_MIN_LEN || file_len != current_len {
        return Ok(None);
    }
    let Some(stamp) = tokens.next() else {
        return Ok(None);
    };
    let transcript = transcript_path(data_dir, session_id)?;
    if modification_stamp(&transcript, &fs::metadata(&transcript)?).as_deref() != Some(stamp) {
        return Ok(None);
    }
    let (Some(message_count), Some(compaction_count), Some(review_state_count)) =
        (tokens.next(), tokens.next(), tokens.next())
    else {
        return Ok(None);
    };
    let (Some(message_count), Some(compaction_count), Some(review_state_count)) = (
        message_count.parse::<usize>().ok(),
        compaction_count.parse::<usize>().ok(),
        review_state_count.parse::<usize>().ok(),
    ) else {
        return Ok(None);
    };
    let Some(offset_count) = message_count
        .checked_add(compaction_count)
        .and_then(|count| count.checked_add(review_state_count))
    else {
        return Ok(None);
    };
    let Ok(file_len_usize) = usize::try_from(file_len) else {
        return Ok(None);
    };
    // A classified JSONL record needs at least `{"type":"message"}\n`;
    // reject impossible counts before reserving memory from cache input.
    if offset_count > file_len_usize / 19 || offset_count > tokens.clone().count() {
        return Ok(None);
    }
    let mut layout = TranscriptLayout {
        message_offsets: Vec::with_capacity(message_count),
        message_ids: Vec::with_capacity(message_count),
        user_message_positions: Vec::new(),
        marker_rows: Vec::new(),
        boundary: OnceLock::new(),
        compaction_offsets: Vec::with_capacity(compaction_count),
        tool_review_state_offsets: Vec::with_capacity(review_state_count),
        file_len,
        identity: cached_identity,
        modification_stamp: Some(stamp.to_string()),
    };
    for index in 0..offset_count {
        let Some(offset) = tokens.next().and_then(|token| token.parse::<u64>().ok()) else {
            return Ok(None);
        };
        if index < message_count {
            layout.message_offsets.push(offset);
        } else if index < message_count + compaction_count {
            layout.compaction_offsets.push(offset);
        } else {
            layout.tool_review_state_offsets.push(offset);
        }
    }
    for index in 0..message_count {
        let Some(token) = tokens.next() else {
            return Ok(None);
        };
        let id = if token == "-" {
            None
        } else {
            let Some(encoded) = token.strip_prefix('+').or_else(|| token.strip_prefix('*')) else {
                return Ok(None);
            };
            let Some(id) = hex::decode(encoded)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
            else {
                return Ok(None);
            };
            if token.starts_with('*') {
                layout.marker_rows.push(index);
            }
            Some(id)
        };
        layout.message_ids.push(id);
    }
    let Some(user_count) = tokens.next().and_then(|token| token.parse::<usize>().ok()) else {
        return Ok(None);
    };
    if user_count > message_count {
        return Ok(None);
    }
    for _ in 0..user_count {
        let Some(position) = tokens.next().and_then(|token| token.parse::<usize>().ok()) else {
            return Ok(None);
        };
        if layout.message_ids.get(position).is_none_or(Option::is_none)
            || layout
                .user_message_positions
                .last()
                .is_some_and(|&last| last >= position)
        {
            return Ok(None);
        }
        layout.user_message_positions.push(position);
    }
    let transcript = transcript_path(data_dir, session_id)?;
    let (Some(checksum_label), Some(checksum)) = (tokens.next(), tokens.next()) else {
        return Ok(None);
    };
    if checksum_label != "checksum"
        || checksum != layout_cache_digest(&layout)
        || tokens.next().is_some()
        || !offsets_are_valid(&layout)
        || !prefix_ends_on_line_boundary(&transcript, file_len)?
    {
        return Ok(None);
    }
    if !offsets_look_like_scan(&transcript, &layout)? {
        return Ok(None);
    }
    Ok(Some(layout))
}

fn offsets_are_valid(layout: &TranscriptLayout) -> bool {
    let groups = [
        &layout.message_offsets,
        &layout.compaction_offsets,
        &layout.tool_review_state_offsets,
    ];
    let mut positions = [0; 3];
    let mut previous = None;
    loop {
        let next = groups
            .iter()
            .enumerate()
            .filter_map(|(index, offsets)| {
                offsets.get(positions[index]).map(|offset| (*offset, index))
            })
            .min();
        let Some((offset, group)) = next else {
            return true;
        };
        if offset >= layout.file_len || previous.is_some_and(|previous| previous >= offset) {
            return false;
        }
        positions[group] += 1;
        previous = Some(offset);
    }
}

fn prefix_ends_on_line_boundary(path: &Path, file_len: u64) -> Result<bool> {
    if file_len == 0 {
        return Ok(true);
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(file_len - 1))?;
    let mut byte = [0u8; 1];
    Ok(file.read_exact(&mut byte).is_ok() && byte[0] == b'\n')
}

fn offsets_look_like_scan(path: &Path, layout: &TranscriptLayout) -> Result<bool> {
    let head = layout
        .message_offsets
        .first()
        .map(|offset| (*offset, "message"))
        .into_iter()
        .chain(
            layout
                .compaction_offsets
                .first()
                .map(|offset| (*offset, "compaction")),
        )
        .chain(
            layout
                .tool_review_state_offsets
                .first()
                .map(|offset| (*offset, "tool_review_state")),
        );
    for (offset, kind) in head {
        if offset >= layout.file_len {
            return Ok(false);
        }
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut prefix = [0u8; 4096];
        let read = BufReader::new(file).read(&mut prefix)?;
        let text = String::from_utf8_lossy(&prefix[..read]);
        if sniff_line_kind(text.trim_end()) != Some(kind) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn layout_cache_digest(layout: &TranscriptLayout) -> String {
    let mut digest = Sha256::new();
    digest.update(LAYOUT_CACHE_MAGIC.as_bytes());
    digest.update(LAYOUT_CACHE_VERSION.as_bytes());
    match &layout.identity {
        FileIdentity::Available {
            platform,
            volume_id,
            file_id,
        } => {
            digest.update(platform.as_bytes());
            digest.update(volume_id.to_le_bytes());
            digest.update(file_id);
        }
        FileIdentity::Unavailable => digest.update(b"unavailable"),
    }
    digest.update(layout.file_len.to_le_bytes());
    digest.update(
        layout
            .modification_stamp
            .as_deref()
            .unwrap_or_default()
            .as_bytes(),
    );
    digest.update((layout.message_offsets.len() as u64).to_le_bytes());
    digest.update((layout.compaction_offsets.len() as u64).to_le_bytes());
    digest.update((layout.tool_review_state_offsets.len() as u64).to_le_bytes());
    for offset in layout
        .message_offsets
        .iter()
        .chain(&layout.compaction_offsets)
        .chain(&layout.tool_review_state_offsets)
    {
        digest.update(offset.to_le_bytes());
    }
    for id in &layout.message_ids {
        match id {
            Some(id) => {
                digest.update([1]);
                digest.update((id.len() as u64).to_le_bytes());
                digest.update(id.as_bytes());
            }
            None => digest.update([0]),
        }
    }
    digest.update((layout.user_message_positions.len() as u64).to_le_bytes());
    for &position in &layout.user_message_positions {
        digest.update((position as u64).to_le_bytes());
    }
    for &position in &layout.marker_rows {
        digest.update((position as u64).to_le_bytes());
    }
    hex::encode(digest.finalize())
}

fn store_layout_cache(data_dir: &Path, session_id: &str, layout: &TranscriptLayout) -> Result<()> {
    if layout.file_len < LAYOUT_CACHE_MIN_LEN || !layout.identity.is_available() {
        return Ok(());
    }
    let Some(stamp) = layout.modification_stamp.as_deref() else {
        return Ok(());
    };
    let path = transcript_path(data_dir, session_id)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() != layout.file_len
        || file_identity(&path, &metadata) != layout.identity
        || modification_stamp(&path, &metadata).as_deref() != Some(stamp)
    {
        return Ok(());
    }
    let cache = layout_cache_path(data_dir, session_id)?;
    let tmp = cache.with_extension("layout.tmp");
    {
        let mut writer = BufWriter::new(File::create(&tmp)?);
        writeln!(writer, "{LAYOUT_CACHE_MAGIC} {LAYOUT_CACHE_VERSION}")?;
        layout.identity.write_tokens(&mut writer)?;
        writeln!(writer, "{}", layout.file_len)?;
        writeln!(writer, "{stamp}")?;
        writeln!(
            writer,
            "{} {} {}",
            layout.message_offsets.len(),
            layout.compaction_offsets.len(),
            layout.tool_review_state_offsets.len()
        )?;
        for offsets in [
            &layout.message_offsets,
            &layout.compaction_offsets,
            &layout.tool_review_state_offsets,
        ] {
            for (index, offset) in offsets.iter().enumerate() {
                if index % 8 == 7 {
                    writeln!(writer, "{offset}")?;
                } else {
                    write!(writer, "{offset} ")?;
                }
            }
            if !offsets.is_empty() && offsets.len() % 8 != 0 {
                writeln!(writer)?;
            }
        }
        for (i, id) in layout.message_ids.iter().enumerate() {
            match id {
                Some(id) => writeln!(
                    writer,
                    "{}{}",
                    if layout.marker_rows.binary_search(&i).is_ok() {
                        '*'
                    } else {
                        '+'
                    },
                    hex::encode(id)
                )?,
                None => writeln!(writer, "-")?,
            }
        }
        writeln!(writer, "{}", layout.user_message_positions.len())?;
        for position in &layout.user_message_positions {
            writeln!(writer, "{position}")?;
        }
        writeln!(writer, "checksum {}", layout_cache_digest(layout))?;
        writer.flush()?;
        writer.get_ref().sync_data()?;
    }
    swap_into_place(&tmp, &cache)
}

#[cfg(unix)]
fn file_identity(_path: &Path, metadata: &fs::Metadata) -> FileIdentity {
    unix_file_identity(metadata)
}

#[cfg(unix)]
pub(super) fn opened_file_identity(_file: &File, metadata: &fs::Metadata) -> FileIdentity {
    unix_file_identity(metadata)
}

#[cfg(unix)]
fn unix_file_identity(metadata: &fs::Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;
    let mut file_id = [0u8; 16];
    file_id[..8].copy_from_slice(&metadata.ino().to_be_bytes());
    FileIdentity::Available {
        platform: "unix",
        volume_id: metadata.dev(),
        file_id,
    }
}

#[cfg(windows)]
fn file_identity(path: &Path, _metadata: &fs::Metadata) -> FileIdentity {
    let Ok(file) = File::open(path) else {
        return FileIdentity::Unavailable;
    };
    opened_file_identity(&file, _metadata)
}

#[cfg(windows)]
pub(super) fn opened_file_identity(file: &File, _metadata: &fs::Metadata) -> FileIdentity {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO},
    };

    let mut info = FILE_ID_INFO::default();
    let result = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if result == 0 {
        return FileIdentity::Unavailable;
    }
    FileIdentity::Available {
        platform: "windows",
        volume_id: info.VolumeSerialNumber,
        file_id: info.FileId.Identifier,
    }
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_path: &Path, _metadata: &fs::Metadata) -> FileIdentity {
    FileIdentity::Unavailable
}

#[cfg(not(any(unix, windows)))]
pub(super) fn opened_file_identity(_file: &File, _metadata: &fs::Metadata) -> FileIdentity {
    FileIdentity::Unavailable
}

#[cfg(test)]
#[path = "../transcripts_layout_tests.rs"]
mod tests;
