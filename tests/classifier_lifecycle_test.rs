use route2::{default_idle_timeout_secs, is_healthy, ClassifierConfig, ClassifierManager, Router};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
#[allow(clippy::zombie_processes)]
fn mcp_disconnect_cancels_startup_and_reaps_the_classifier() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("reserve fixture port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let prefix = format!("route2-disconnect-{}-{port}", std::process::id());
    let config_path = std::env::temp_dir().join(format!("{prefix}.json"));
    let marker_path = std::env::temp_dir().join(format!("{prefix}.pid"));
    let marker_literal = serde_json::to_string(&marker_path.to_string_lossy()).unwrap();
    let script = format!(
        "import os,time,pathlib; pathlib.Path({marker_literal}).write_text(str(os.getpid())); time.sleep(60)"
    );
    let policy = serde_json::json!({
        "policy_version": "disconnect-fixture", "backend": "decision", "decision": {
            "endpoint": format!("http://127.0.0.1:{port}/v1/systemone"),
            "command": python_command(), "args": ["-c", script],
            "startup_timeout_ms": 15000, "idle_timeout_secs": 0
        }
    });
    std::fs::write(&config_path, policy.to_string()).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_route2"))
        .arg("--mcp")
        .env("ROUTE2_CONFIG", &config_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start MCP fixture");
    let mut input = child.stdin.take().unwrap();
    writeln!(
        input,
        "{}",
        serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "route", "arguments": {"task": "startup fixture"}}
        })
    )
    .unwrap();
    input.flush().unwrap();
    let started = Instant::now();
    while !marker_path.exists() && started.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
    let spawned = marker_path.exists();
    drop(input);
    let disconnected = Instant::now();
    let mut status = None;
    while disconnected.elapsed() < Duration::from_secs(3) {
        status = child.try_wait().unwrap();
        if status.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if status.is_some() {
        let _ = child.wait();
    }
    let classifier_pid = std::fs::read_to_string(&marker_path).unwrap_or_default();
    let classifier_alive = !classifier_pid.is_empty()
        && Command::new("/bin/kill")
            .args(["-0", classifier_pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if classifier_alive {
        let _ = Command::new("/bin/kill")
            .args(["-9", classifier_pid.trim()])
            .status();
    }
    let _ = std::fs::remove_file(config_path);
    let _ = std::fs::remove_file(marker_path);
    assert!(spawned, "classifier must have started before disconnect");
    assert!(
        status.is_some_and(|value| value.success()),
        "MCP must exit promptly on disconnect"
    );
    assert!(
        !classifier_alive,
        "disconnect must reap the loading classifier"
    );
}

fn python_command() -> String {
    if let Ok(command) = std::env::var("ROUTE2_TEST_PYTHON") {
        return command;
    }
    "python3".to_string()
}

#[test]
fn test_classifier_default_idle_timeout_keeps_classifier_warm() {
    assert_eq!(default_idle_timeout_secs(), 0);
    assert_eq!(ClassifierConfig::default().idle_timeout_secs, 0);

    let router = Router::from_json(route2::POLICY_CONFIG).expect("built-in policy parses");
    assert_eq!(router.classifier_manager().config().idle_timeout_secs, 0);
}

#[test]
fn classifier_defaults_match_the_pinned_decision_runtime() {
    let router = Router::from_json(route2::POLICY_CONFIG).expect("built-in policy parses");
    let embedded = router.classifier_manager().config();
    let defaults = ClassifierConfig::default();
    assert_eq!(defaults.model, embedded.model);
    assert_eq!(defaults.args, embedded.args);
    assert_eq!(defaults.timeout_ms, embedded.timeout_ms);
    let defaulted = Router::from_json(r#"{"policy_version":"default-backend","decision":{}}"#)
        .expect("missing backend selects Decision 2.0");
    assert_eq!(defaulted.backend_name(), "decision");
}

#[test]
fn test_classifier_cold_start_automatic_spawn_and_watchdog_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let endpoint = format!("http://127.0.0.1:{port}/v1/systemone");
    assert!(
        !is_healthy(&endpoint),
        "endpoint should be offline initially"
    );
    let py_script = format!(
        "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',{port})); s.listen(); time.sleep(60)"
    );
    let config = ClassifierConfig {
        endpoint: endpoint.clone(),
        command: python_command(),
        args: vec!["-c".to_string(), py_script],
        startup_timeout_ms: 5000,
        idle_timeout_secs: 1,
        ..ClassifierConfig::default()
    };

    let manager = ClassifierManager::new(config);
    manager.ensure_running().expect("automatic cold start");
    assert!(manager.is_child_running());
    assert!(is_healthy(&endpoint));

    for _ in 0..30 {
        if !manager.is_child_running() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        !manager.is_child_running(),
        "watchdog must stop the idle child"
    );
    assert!(
        !is_healthy(&endpoint),
        "endpoint must close after idle timeout"
    );
}

#[test]
fn test_mcp_invokes_classifier_cold_start_automatically() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let endpoint = format!("http://127.0.0.1:{port}/v1/systemone");
    let py_script = format!(
        "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',{port})); s.listen(); time.sleep(60)"
    );
    let policy_json = serde_json::json!({
        "policy_version": "test-mcp-coldstart-v1",
        "backend": "decision",
        "decision": {
            "endpoint": endpoint,
            "command": python_command(),
            "args": ["-c", py_script],
            "startup_timeout_ms": 5000,
            "idle_timeout_secs": 1
        }
    })
    .to_string();

    let router = Router::from_json(&policy_json).expect("valid policy");
    assert!(!router.classifier_manager().is_child_running());
    router
        .ensure_classifier_running()
        .expect("MCP router cold start");
    assert!(router.classifier_manager().is_child_running());
    router.stop_classifier();
    assert!(!router.classifier_manager().is_child_running());
}

#[test]
fn test_stop_terminates_launcher_process_tree() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let child_script = format!(
        "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',{port})); s.listen(); time.sleep(60)"
    );
    let child_literal = serde_json::to_string(&child_script).unwrap();
    let parent_script = format!(
        "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{child_literal}]); time.sleep(60)"
    );
    let config = ClassifierConfig {
        endpoint: format!("http://127.0.0.1:{port}/v1/systemone"),
        command: python_command(),
        args: vec!["-c".to_string(), parent_script],
        startup_timeout_ms: 5000,
        ..ClassifierConfig::default()
    };

    let manager = ClassifierManager::new(config);
    manager
        .ensure_running()
        .expect("launcher starts child server");
    assert!(is_healthy(manager.config().endpoint.as_str()));
    manager.stop();
    for _ in 0..20 {
        if !is_healthy(manager.config().endpoint.as_str()) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        !is_healthy(manager.config().endpoint.as_str()),
        "stopping the launcher must terminate the model-server child"
    );
}

#[test]
fn test_classifier_startup_stderr_is_bounded_and_keeps_diagnostics() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let py_script = r#"import sys
sys.stderr.write('x' * 40000)
sys.stderr.write('\n[Route2 classifier] {"stage":"loading_model","message":"loading local classifier","elapsed_ms":7}\n')
sys.stderr.flush()
sys.exit(1)
"#;
    let config = ClassifierConfig {
        endpoint: format!("http://127.0.0.1:{port}/v1/systemone"),
        command: python_command(),
        args: vec!["-c".to_string(), py_script.to_string()],
        startup_timeout_ms: 5000,
        ..ClassifierConfig::default()
    };

    let error = ClassifierManager::new(config)
        .ensure_running()
        .expect_err("test classifier must exit during startup");
    assert!(error.contains("loading_model"));
    assert!(error.contains("[earlier stderr truncated]"));
    assert!(error.len() < 20_000, "stderr diagnostics must stay bounded");
}

#[test]
fn test_classifier_lifecycle_events_are_relayed_without_task_content() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let py_script = r#"import sys
print('[Route2 classifier] {"stage":"checking_weights","message":"checking local weights","elapsed_ms":1}', file=sys.stderr, flush=True)
print('[Route2 classifier] {"stage":"loading_model","message":"loading local classifier","elapsed_ms":2}', file=sys.stderr, flush=True)
sys.exit(1)
"#;
    let config_path = std::env::temp_dir().join(format!(
        "route2-classifier-lifecycle-{}-{port}.json",
        std::process::id()
    ));
    let policy = serde_json::json!({
        "policy_version": "classifier-lifecycle-test-v1",
        "backend": "decision",
        "decision": {
            "endpoint": format!("http://127.0.0.1:{port}/v1/systemone"),
            "command": python_command(),
            "args": ["-c", py_script],
            "startup_timeout_ms": 5000,
            "idle_timeout_secs": 0
        }
    });
    std::fs::write(&config_path, policy.to_string()).expect("write lifecycle test policy");

    let mut child = Command::new(env!("CARGO_BIN_EXE_route2"))
        .arg("--mcp")
        .env("ROUTE2_CONFIG", &config_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("route2 MCP process starts");
    let mut stdin = child.stdin.take().expect("MCP stdin");
    let stdout = child.stdout.take().expect("MCP stdout");
    let mut stdout = BufReader::new(stdout);

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "route",
            "arguments": {"task": "task content must not be logged"}
        }
    });
    writeln!(stdin, "{request}").expect("write route request");
    stdin.flush().expect("flush route request");
    let mut response = String::new();
    stdout
        .read_line(&mut response)
        .expect("read route response");
    let response: serde_json::Value =
        serde_json::from_str(&response).expect("valid route response");
    assert_eq!(response["result"]["isError"], true);

    writeln!(
        stdin,
        "{}",
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"exit"})
    )
    .expect("write exit request");
    stdin.flush().expect("flush exit request");
    drop(stdin);

    let mut stderr = String::new();
    child
        .stderr
        .take()
        .expect("MCP stderr")
        .read_to_string(&mut stderr)
        .expect("read lifecycle stderr");
    let status = child.wait().expect("MCP process exits");
    assert!(status.success());
    let _ = std::fs::remove_file(config_path);

    assert!(stderr.contains("[Route2 classifier] {\"stage\":\"starting\""));
    assert!(stderr.contains("[Route2 classifier] {\"stage\":\"checking_weights\""));
    assert!(stderr.contains("[Route2 classifier] {\"stage\":\"loading_model\""));
    assert!(stderr.contains("[Route2 classifier] {\"stage\":\"error\""));
    assert!(!stderr.contains("task content must not be logged"));
}
