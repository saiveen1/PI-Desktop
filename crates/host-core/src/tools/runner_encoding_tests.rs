//! Windows pipe encoding tests run in child libtest processes to isolate inheritance.
use super::*;

const CHILD_TEST: &str = "tools::runner_encoding_tests::python_encoding_child";
const CASE_ENV: &str = "PI_TEST_RUNNER_ENCODING_CASE";

#[tokio::test]
async fn windows_python_stdio_default_inheritance_and_overrides() {
    if shell::resolve_shell(shell::GIT_BASH_ID).is_err() {
        eprintln!("Git Bash unavailable; skipping Windows Python pipe integration test");
        return;
    }
    let python = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new("python")
            .arg("--version")
            .kill_on_drop(true)
            .output(),
    )
    .await;
    match python {
        Ok(Ok(output)) if output.status.success() => {}
        _ => {
            eprintln!("Python unavailable; skipping Windows Python pipe integration test");
            return;
        }
    }
    for case in ["default", "inherited", "extra"] {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", CHILD_TEST, "--ignored", "--nocapture"])
            .env(CASE_ENV, case)
            .env_remove("PYTHONIOENCODING")
            .kill_on_drop(true);
        if case == "inherited" {
            command.env("PYTHONIOENCODING", "ascii:backslashreplace");
        } else if case == "extra" {
            command.env("PYTHONIOENCODING", "latin-1:replace");
        }
        let output = tokio::time::timeout(Duration::from_secs(30), command.output())
            .await
            .expect("encoding child exceeded its fixed test budget")
            .unwrap();
        assert!(
            output.status.success(),
            "{case}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[tokio::test]
#[ignore = "invoked by windows_python_stdio_default_inheritance_and_overrides with isolated child environment"]
async fn python_encoding_child() {
    let case = std::env::var(CASE_ENV).expect("only run through the encoding parent test");
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let scratch = data.path().join("scratch");
    std::fs::create_dir(&scratch).unwrap();
    // ASCII source avoids coupling command/source encoding to Python's pipe encoding.
    std::fs::write(
        workspace.path().join("probe.py"),
        "import sys\ns = '\\u4e2d\\u6587\\U0001f600'\nprint(s)\nprint(s, file=sys.stderr)\n",
    )
    .unwrap();
    let expected = if case == "default" {
        "中文😀\n"
    } else {
        "\\u4e2d\\u6587\\U0001f600\n"
    };
    let extra_env = if case == "extra" {
        vec![("pythonioencoding".into(), "ascii:backslashreplace".into())]
    } else {
        Vec::new()
    };
    // Exercise the same environment helper used by the production hidden runner
    // directly as well as the libtest foreground/background shell adapter.
    let config = ToolRunnerStartConfig {
        program: PathBuf::from("python"),
        args: vec!["-X".into(), "utf8=0".into(), "probe.py".into()],
        workspace: workspace.path().to_path_buf(),
        scratch_dir: Some(scratch.clone()),
        env_path: None,
        extra_env: extra_env.clone(),
    };
    let inherited = std::env::var_os("PYTHONIOENCODING");
    let mut command = Command::new(&config.program);
    command
        .args(&config.args)
        .current_dir(&config.workspace)
        .kill_on_drop(true);
    runner_environment::apply(&mut command, &config);
    assert_eq!(std::env::var_os("PYTHONIOENCODING"), inherited);
    assert!(!command
        .as_std()
        .get_envs()
        .any(|(name, _)| name == "PYTHONUTF8"));
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(output.status.success(), "direct {case}: {output:?}");
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().replace('\r', ""),
        expected
    );
    assert_eq!(
        String::from_utf8(output.stderr).unwrap().replace('\r', ""),
        expected
    );
    let mut options = BashExecutionOptions::local(shell::GIT_BASH_ID.into(), Some(5_000));
    options.extra_env = extra_env;
    let result = tool_bash(
        Some(workspace.path()),
        Some(&scratch),
        &json!({"command":"python -X utf8=0 probe.py"}),
        options,
    )
    .await
    .unwrap();
    assert_eq!(result["exitCode"], 0, "foreground {case}: {result}");
    assert_eq!(
        result["stdout"].as_str().unwrap().replace('\r', ""),
        expected,
        "foreground {case}: {result}"
    );
    assert_eq!(
        result["stderr"].as_str().unwrap().replace('\r', ""),
        expected,
        "foreground {case}: {result}"
    );

    let state = Arc::new(tokio::sync::Mutex::new(
        crate::state::AppState::open(data.path()).unwrap(),
    ));
    let session = {
        let st = state.lock().await;
        crate::sessions::create_session(
            &st.db,
            Some("encoding fixture".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap()
        .id
    };
    let mut options = BashExecutionOptions::local(shell::GIT_BASH_ID.into(), None);
    options.session_id = session.clone();
    options.run_in_background = true;
    options.app_state = Some(state.clone());
    // The detached API has no extra-env field. A command's explicit override must still win.
    let command = if case == "extra" {
        "PYTHONIOENCODING=ascii:backslashreplace python -X utf8=0 probe.py"
    } else {
        "python -X utf8=0 probe.py"
    };
    let started = tool_bash(
        Some(workspace.path()),
        Some(&scratch),
        &json!({"command":command}),
        options,
    )
    .await
    .unwrap();
    let task = {
        let st = state.lock().await;
        crate::background_tasks::jobs::find(
            &st.background_tasks,
            &session,
            started["backgroundTaskId"].as_str().unwrap(),
        )
        .unwrap()
    };
    crate::background_tasks::jobs::wait(&task, 5_000).await;
    let result = crate::background_tasks::jobs::snapshot(&task, true).await;
    state.lock().await.shutdown();
    assert_eq!(result["state"], "exited", "background {case}: {result}");
    assert_eq!(result["exitCode"], 0, "background {case}: {result}");
    assert_eq!(result["stdout"], expected, "background {case}: {result}");
    assert_eq!(result["stderr"], expected, "background {case}: {result}");
}
