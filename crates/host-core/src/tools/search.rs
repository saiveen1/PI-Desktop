//! Metadata enumeration and per-file coordinated content searches.
use super::search_control::SearchControl;
use super::*;

fn candidate_files(
    search_root: &Path,
    ignore_root: &Path,
    scoped: bool,
    include: Option<&globset::GlobSet>,
    max_files: usize,
    control: &SearchControl,
) -> Result<(Vec<PathBuf>, bool), (String, String)> {
    control.check()?;
    if search_root.is_file() {
        if ignore_rules::is_sensitive_path(search_root) {
            return Ok((Vec::new(), false));
        }
        let relative = search_root
            .file_name()
            .map(Path::new)
            .unwrap_or(search_root);
        if include.is_some_and(|set| !glob_matches(set, relative)) {
            return Ok((Vec::new(), false));
        }
        return Ok((vec![search_root.to_path_buf()], false));
    }
    let mut walker = WalkBuilder::new(search_root);
    walker.hidden(false).git_ignore(true);
    if scoped {
        walker.parents(false);
    }
    ignore_rules::configure_walker(&mut walker, ignore_root, scoped);
    let mut candidates: Vec<(PathBuf, SystemTime)> = Vec::new();
    let mut capped = false;
    // Check errors too: an unreadable tree must remain cancellable.
    for entry in walker.build() {
        control.check()?;
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let relative = path.strip_prefix(search_root).unwrap_or(path);
        if include.is_some_and(|set| !glob_matches(set, relative)) {
            continue;
        }
        if candidates.len() >= max_files {
            capped = true;
            break;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .unwrap_or(UNIX_EPOCH);
        candidates.push((path.to_path_buf(), mtime));
    }
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    control.check()?;
    Ok((
        candidates.into_iter().map(|(path, _)| path).collect(),
        capped,
    ))
}

pub(super) fn tool_glob(
    workspace: Option<&Path>,
    roots: &ContainedRoots,
    args: &Value,
    allow_external_paths: bool,
    control: &SearchControl,
) -> Result<Value, (String, String)> {
    control.check()?;
    let root = require_workspace(workspace)?;
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .unwrap_or("**/*");
    let set = build_glob_set(pattern)?;
    let (search_dir, root_kind, scoped) = search_root(
        root,
        roots,
        args,
        allow_external_paths,
        SearchPathKind::DirectoryOnly,
    )?;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| v.min(GLOB_MAX_LIMIT as u64) as usize)
        .filter(|v| *v > 0)
        .unwrap_or(GLOB_DEFAULT_LIMIT);
    let ignore_root = if root_kind == ToolRoot::Workspace {
        root
    } else {
        search_dir.as_path()
    };
    let (files, mut truncated) = candidate_files(
        &search_dir,
        ignore_root,
        scoped,
        Some(&set),
        GLOB_MAX_LIMIT * 8,
        control,
    )?;
    let mut matches: Vec<String> = Vec::new();
    let mut bytes = 0_usize;
    for path in &files {
        control.check()?;
        if matches.len() >= limit {
            truncated = true;
            break;
        }
        let shown = display_tool_path(root_kind, root, path);
        bytes += shown.len() + 8;
        if bytes > BUDGET_SEARCH.max_bytes {
            truncated = true;
            break;
        }
        matches.push(shown);
    }
    let mut out = json!({"matches": matches, "count": matches.len(), "truncated": truncated});
    if truncated {
        out["notice"] = json!(format!("more files match; raise limit (max {GLOB_MAX_LIMIT}) or narrow pattern/path. Results are ordered by modification time, newest first"));
    }
    Ok(out)
}

pub(super) fn tool_grep(
    workspace: Option<&Path>,
    roots: &ContainedRoots,
    args: &Value,
    allow_external_paths: bool,
    hashline: Option<&HashlineContext<'_>>,
    control: &SearchControl,
) -> Result<Value, (String, String)> {
    control.check()?;
    let root = require_workspace(workspace)?;
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or_else(|| ("INVALID_ARGUMENT".into(), "pattern required".into()))?;
    let case_insensitive = args
        .get("caseInsensitive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let re = RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|e| ("INVALID_ARGUMENT".into(), e.to_string()))?;
    let (search_dir, root_kind, scoped) = search_root(
        root,
        roots,
        args,
        allow_external_paths,
        SearchPathKind::FileOrDirectory,
    )?;
    let include_pattern = args
        .get("include")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty());
    let include = include_pattern.map(build_glob_set).transpose()?;
    let mode = match args.get("outputMode").and_then(Value::as_str) {
        Some("files_with_matches") | Some("files-with-matches") => "filesWithMatches",
        Some(value) => value,
        None => "content",
    };
    if !matches!(mode, "content" | "filesWithMatches" | "count") {
        return Err((
            "INVALID_ARGUMENT".into(),
            format!("unknown outputMode: {mode} (content | filesWithMatches | count)"),
        ));
    }
    let head_limit = args
        .get("headLimit")
        .and_then(Value::as_u64)
        .map(|v| v.min(BUDGET_SEARCH.max_lines as u64) as usize)
        .filter(|v| *v > 0)
        .unwrap_or(GREP_DEFAULT_HEAD_LIMIT);
    let ignore_root = if root_kind == ToolRoot::Workspace {
        root
    } else {
        search_dir.as_path()
    };

    // An external whole-tree rg process cannot participate in per-file leases.
    // Uncoordinated callers retain the existing optional system backend.
    if !control.coordinated() {
        if let Some(value) = grep_rg::try_system_rg(grep_rg::SystemGrep {
            pattern,
            search_dir: &search_dir,
            workspace_root: root,
            ignore_root,
            root_kind,
            scoped,
            include: include_pattern,
            mode,
            case_insensitive,
            head_limit,
        }) {
            control.check()?;
            return Ok(mint_grep_tags(
                root,
                roots,
                allow_external_paths,
                mode,
                value,
                hashline,
            ));
        }
    }
    let (files, mut truncated) = candidate_files(
        &search_dir,
        ignore_root,
        scoped,
        include.as_ref(),
        GREP_MAX_CANDIDATE_FILES,
        control,
    )?;
    let mut hits: Vec<Value> = Vec::new();
    let mut counts: Vec<Value> = Vec::new();
    let mut matched_files: Vec<String> = Vec::new();
    let mut tags = serde_json::Map::new();
    let mut total_matches = 0_usize;
    let mut clipped_lines = 0_usize;
    let mut bytes = 0_usize;
    for path in &files {
        let _file_lease = control.read_file(root, roots, path, allow_external_paths)?;
        #[cfg(test)]
        file_lease_tests::pause(Some(root), path.to_str());
        control.check()?;
        let Ok(mut reader) = LineReader::open(path) else {
            continue;
        };
        if reader.looks_binary() {
            continue;
        }
        let shown = display_tool_path(root_kind, root, path);
        let mut line_no = 0_usize;
        let mut file_matches = 0_usize;
        let mut matched_lines = Vec::new();
        let mut stop = false;
        // Preserve the existing partial-readable-file behavior.
        while let Ok(Some(line)) = reader.next_line_checked(MAX_LINE_CHARS, || {
            control
                .check()
                .map_err(|(_, message)| std::io::Error::new(ErrorKind::Interrupted, message))
        }) {
            control.check()?;
            line_no += 1;
            if !re.is_match(&line.text) {
                continue;
            }
            file_matches += 1;
            total_matches += 1;
            if line.clipped {
                clipped_lines += 1;
            }
            match mode {
                "content" => {
                    bytes += shown.len() + line.text.len() + 48;
                    if hits.len() >= head_limit || bytes > BUDGET_SEARCH.max_bytes {
                        truncated = true;
                        stop = true;
                        break;
                    }
                    matched_lines.push(line_no as u64);
                    hits.push(json!({"path": shown, "line": line_no, "text": line.text}));
                }
                "filesWithMatches" => break,
                _ => {}
            }
        }
        control.check()?;
        // Record the tag for the same file version as the displayed matches,
        // before releasing its lease, including when the output budget is hit.
        if !matched_lines.is_empty() || (mode != "content" && file_matches > 0) {
            matched_files.push(shown.clone());
            // Preserve the existing path-resolution boundary for edit tags.
            if let Ok((resolved, _)) =
                resolve_tool_path_with_external(root, roots, &shown, allow_external_paths)
            {
                if let Some((display, tag)) =
                    hashline::record_grep_file(hashline, &resolved, &shown, Some(&matched_lines))
                {
                    tags.insert(display, json!(tag));
                }
            }
        }
        if stop {
            break;
        }
        if file_matches == 0 {
            continue;
        }
        if mode == "count" {
            counts.push(json!({"path": shown, "count": file_matches}));
        }
        if mode != "content" && matched_files.len() >= head_limit {
            truncated = true;
            break;
        }
    }
    Ok(hashline::attach_tags(
        grep_output(
            mode,
            hits,
            counts,
            matched_files,
            total_matches,
            clipped_lines,
            truncated,
        ),
        tags,
    ))
}
