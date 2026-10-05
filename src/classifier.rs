//! Decision 2.0 classifier lifecycle, health checks, and inference.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, Weak,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::{ROUTING_DECISION_INSTRUCTIONS, ROUTING_TIER_CRITERIA};

pub const DEFAULT_CLASSIFIER_ENDPOINT: &str = "http://127.0.0.1:8009/v1/systemone";
pub const DEFAULT_CLASSIFIER_MODEL: &str = "vllm-sr/Decision-2.0-Kai-0.6B";
pub const DEFAULT_TIMEOUT_MS: u64 = 30000;
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 0;
pub const DEFAULT_STARTUP_TIMEOUT_MS: u64 = 900000;

const CLASSIFIER_LIFECYCLE_PREFIX: &str = "[Route2 classifier] ";
const MAX_CLASSIFIER_STDERR_BYTES: usize = 16 * 1024;
const MAX_CLASSIFIER_STDERR_LINE_BYTES: usize = 4 * 1024;
const MAX_CLASSIFIER_LIFECYCLE_MESSAGE_BYTES: usize = 512;

#[derive(Serialize)]
struct ClassifierLifecycle<'a> {
    stage: &'a str,
    message: String,
    elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClassifierConfig {
    #[serde(default = "default_classifier_endpoint")]
    pub endpoint: String,
    #[serde(default = "default_classifier_model")]
    pub model: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_classifier_command")]
    pub command: String,
    #[serde(default = "default_classifier_args")]
    pub args: Vec<String>,
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
    #[serde(default = "default_startup_timeout_ms")]
    pub startup_timeout_ms: u64,
}

impl Default for ClassifierConfig {
    fn default() -> Self {
        Self {
            endpoint: default_classifier_endpoint(),
            model: default_classifier_model(),
            timeout_ms: default_timeout_ms(),
            command: default_classifier_command(),
            args: default_classifier_args(),
            idle_timeout_secs: default_idle_timeout_secs(),
            startup_timeout_ms: default_startup_timeout_ms(),
        }
    }
}

pub fn default_classifier_endpoint() -> String {
    DEFAULT_CLASSIFIER_ENDPOINT.to_string()
}

pub fn default_classifier_model() -> String {
    DEFAULT_CLASSIFIER_MODEL.to_string()
}

pub fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

pub fn default_classifier_command() -> String {
    "uv".to_string()
}

pub fn default_classifier_args() -> Vec<String> {
    let policy: serde_json::Value =
        serde_json::from_str(crate::POLICY_CONFIG).expect("embedded classifier policy is valid");
    policy["decision"]["args"]
        .as_array()
        .expect("embedded classifier arguments are present")
        .iter()
        .map(|argument| {
            argument
                .as_str()
                .expect("classifier argument is text")
                .to_string()
        })
        .collect()
}

pub fn default_idle_timeout_secs() -> u64 {
    DEFAULT_IDLE_TIMEOUT_SECS
}

pub fn default_startup_timeout_ms() -> u64 {
    DEFAULT_STARTUP_TIMEOUT_MS
}

#[derive(Debug, Default)]
struct BoundedStderr {
    bytes: VecDeque<u8>,
    truncated: bool,
}

impl BoundedStderr {
    fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }

        if bytes.len() >= MAX_CLASSIFIER_STDERR_BYTES {
            self.bytes.clear();
            self.bytes.extend(
                bytes[bytes.len() - MAX_CLASSIFIER_STDERR_BYTES..]
                    .iter()
                    .copied(),
            );
            self.truncated = true;
            return;
        }

        let overflow = self
            .bytes
            .len()
            .saturating_add(bytes.len())
            .saturating_sub(MAX_CLASSIFIER_STDERR_BYTES);
        for _ in 0..overflow {
            self.bytes.pop_front();
        }
        if overflow > 0 {
            self.truncated = true;
        }
        self.bytes.extend(bytes.iter().copied());
    }

    fn snapshot(&self) -> String {
        let bytes: Vec<u8> = self.bytes.iter().copied().collect();
        let text = String::from_utf8_lossy(&bytes).trim().to_string();
        if text.is_empty() {
            return String::new();
        }
        if self.truncated {
            format!("[earlier stderr truncated] {text}")
        } else {
            text
        }
    }
}

fn bounded_lifecycle_message(message: &str) -> String {
    let mut bounded = String::new();
    for character in message.chars() {
        if character.is_control()
            || bounded.len().saturating_add(character.len_utf8())
                > MAX_CLASSIFIER_LIFECYCLE_MESSAGE_BYTES
        {
            continue;
        }
        bounded.push(character);
    }
    if bounded.is_empty() {
        "classifier status".to_string()
    } else {
        bounded
    }
}

fn emit_classifier_lifecycle_ms(stage: &str, message: &str, elapsed_ms: u64) {
    let payload = serde_json::to_string(&ClassifierLifecycle {
        stage,
        message: bounded_lifecycle_message(message),
        elapsed_ms,
    })
    .expect("classifier lifecycle is serializable");
    eprintln!("{CLASSIFIER_LIFECYCLE_PREFIX}{payload}");
}

fn emit_classifier_lifecycle(stage: &str, message: &str, started: Instant) {
    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    emit_classifier_lifecycle_ms(stage, message, elapsed_ms);
}

fn is_relayable_lifecycle_stage(stage: &str) -> bool {
    matches!(
        stage,
        "starting"
            | "loading_dependencies"
            | "checking_weights"
            | "downloading_weights"
            | "materializing_weights"
            | "loading_model"
            | "ready"
            | "error"
    )
}

fn relay_lifecycle_line(line: &[u8], truncated: bool) {
    if truncated {
        return;
    }

    let line = String::from_utf8_lossy(line).trim().to_string();
    let Some(payload) = line.strip_prefix(CLASSIFIER_LIFECYCLE_PREFIX) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        return;
    };
    let Some(stage) = value.get("stage").and_then(serde_json::Value::as_str) else {
        return;
    };
    if !is_relayable_lifecycle_stage(stage) {
        return;
    }
    let message = value
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("classifier status");
    let elapsed_ms = value
        .get("elapsed_ms")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    emit_classifier_lifecycle_ms(stage, message, elapsed_ms);
}

fn capture_child_stderr(
    mut stderr: ChildStderr,
    buffer: Arc<Mutex<BoundedStderr>>,
    capture_startup: Arc<AtomicBool>,
) {
    let mut chunk = [0_u8; 4096];
    let mut line = Vec::with_capacity(256);
    let mut line_truncated = false;

    loop {
        let read = match stderr.read(&mut chunk) {
            Ok(read) => read,
            Err(_) => return,
        };
        if read == 0 {
            break;
        }

        if !capture_startup.load(Ordering::Acquire) {
            line.clear();
            line_truncated = false;
            continue;
        }

        if let Ok(mut output) = buffer.lock() {
            output.push(&chunk[..read]);
        }

        for byte in &chunk[..read] {
            if *byte == b'\n' {
                relay_lifecycle_line(&line, line_truncated);
                line.clear();
                line_truncated = false;
            } else if line.len() < MAX_CLASSIFIER_STDERR_LINE_BYTES {
                line.push(*byte);
            } else {
                line_truncated = true;
            }
        }
    }

    if capture_startup.load(Ordering::Acquire) && (!line.is_empty() || line_truncated) {
        relay_lifecycle_line(&line, line_truncated);
    }
}

fn stderr_snapshot(buffer: &Arc<Mutex<BoundedStderr>>) -> String {
    buffer
        .lock()
        .map(|value| value.snapshot())
        .unwrap_or_default()
}

fn append_stderr_diagnostic(message: String, buffer: &Arc<Mutex<BoundedStderr>>) -> String {
    let stderr = stderr_snapshot(buffer);
    if stderr.is_empty() {
        message
    } else {
        format!("{message}; stderr: {stderr}")
    }
}

pub fn parse_host_port(endpoint: &str) -> Option<(String, u16)> {
    let url = endpoint
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let host_port = url.split('/').next()?;
    let mut parts = host_port.split(':');
    let host = parts.next()?.to_string();
    let port = parts
        .next()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(80);
    Some((host, port))
}

pub fn is_healthy(endpoint: &str) -> bool {
    if let Some((host, port)) = parse_host_port(endpoint) {
        let addr = format!("{host}:{port}");
        if let Ok(mut addrs) = addr.to_socket_addrs() {
            if let Some(sock_addr) = addrs.next() {
                return TcpStream::connect_timeout(&sock_addr, Duration::from_millis(150)).is_ok();
            }
        }
    }
    false
}

#[derive(Debug)]
struct ClassifierManagerInner {
    config: ClassifierConfig,
    child: Mutex<Option<Child>>,
    last_activity: Mutex<Instant>,
    watchdog_running: AtomicBool,
    shutdown_requested: AtomicBool,
}

impl Drop for ClassifierManagerInner {
    fn drop(&mut self) {
        if let Ok(mut child_guard) = self.child.lock() {
            if let Some(mut child) = child_guard.take() {
                terminate_child_tree(&mut child);
            }
        }
    }
}

fn terminate_child_tree(child: &mut Child) {
    unsafe extern "C" {
        fn kill(pid: std::ffi::c_int, signal: std::ffi::c_int) -> std::ffi::c_int;
    }
    unsafe {
        kill(-(child.id() as std::ffi::c_int), 9);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Shared manager that handles local classifier automatic cold-start, health checks,
/// inference calls, and idle auto-timeout.
#[derive(Debug, Clone)]
pub struct ClassifierManager {
    inner: Arc<ClassifierManagerInner>,
}

impl ClassifierManager {
    pub fn new(config: ClassifierConfig) -> Self {
        Self {
            inner: Arc::new(ClassifierManagerInner {
                config,
                child: Mutex::new(None),
                last_activity: Mutex::new(Instant::now()),
                watchdog_running: AtomicBool::new(false),
                shutdown_requested: AtomicBool::new(false),
            }),
        }
    }

    pub fn config(&self) -> &ClassifierConfig {
        &self.inner.config
    }

    pub fn touch_activity(&self) {
        if let Ok(mut lock) = self.inner.last_activity.lock() {
            *lock = Instant::now();
        }
    }

    /// Ensure the local classifier server is running; if not, automatically cold-starts it.
    pub fn ensure_running(&self) -> Result<(), String> {
        if self.inner.shutdown_requested.load(Ordering::Acquire) {
            return Err("classifier service is shutting down".to_string());
        }
        self.touch_activity();

        let endpoint = std::env::var("ROUTE2_CLASSIFIER_ENDPOINT")
            .unwrap_or_else(|_| self.inner.config.endpoint.clone());

        if is_healthy(&endpoint) {
            return Ok(());
        }

        let mut child_guard = self
            .inner
            .child
            .lock()
            .map_err(|e| format!("mutex lock error: {e}"))?;

        if self.inner.shutdown_requested.load(Ordering::Acquire) {
            return Err("classifier service is shutting down".to_string());
        }

        // Re-check after acquiring lock
        if is_healthy(&endpoint) {
            return Ok(());
        }

        // Clean up previous dead/hung process if any
        if let Some(mut existing) = child_guard.take() {
            terminate_child_tree(&mut existing);
        }

        let lifecycle_started = Instant::now();
        emit_classifier_lifecycle("starting", "starting local classifier", lifecycle_started);

        let cmd_name = if let Ok(custom) = std::env::var("ROUTE2_CLASSIFIER_CMD") {
            custom
        } else {
            let configured = &self.inner.config.command;
            if configured == "uv" {
                let local_uv = if let Ok(exe_path) = std::env::current_exe() {
                    let candidate = exe_path
                        .parent()
                        .and_then(|p| p.parent())
                        .map(|p| p.join("benchmark-python").join("bin").join("uv"));
                    if let Some(ref c) = candidate {
                        if c.is_file() {
                            Some(c.to_string_lossy().to_string())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };
                if let Some(path) = local_uv {
                    path
                } else {
                    let direct = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("target/benchmark-python/bin")
                        .join("uv");
                    if direct.is_file() {
                        direct.to_string_lossy().to_string()
                    } else {
                        configured.clone()
                    }
                }
            } else {
                configured.clone()
            }
        };

        let mut args: Vec<String> = if let Ok(args_str) = std::env::var("ROUTE2_CLASSIFIER_ARGS") {
            args_str.split_whitespace().map(|s| s.to_string()).collect()
        } else {
            self.inner.config.args.clone()
        };

        if args.iter().any(|arg| arg == "{route2_source_dir}") {
            let source = crate::source_root();
            for arg in &mut args {
                if arg == "{route2_source_dir}" {
                    *arg = source.to_string_lossy().to_string();
                }
            }
        }

        let mut command = Command::new(&cmd_name);
        command.args(&args);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::piped());

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                emit_classifier_lifecycle(
                    "error",
                    "failed to spawn local classifier",
                    lifecycle_started,
                );
                return Err(format!(
                    "Cold-start failed for local classifier using command '{cmd_name}': {error}"
                ));
            }
        };

        let stderr_buffer = Arc::new(Mutex::new(BoundedStderr::default()));
        let capture_startup = Arc::new(AtomicBool::new(true));
        let mut stderr_thread: Option<JoinHandle<()>> = child.stderr.take().map(|stderr| {
            let buffer = Arc::clone(&stderr_buffer);
            let capture_startup = Arc::clone(&capture_startup);
            std::thread::spawn(move || capture_child_stderr(stderr, buffer, capture_startup))
        });

        let startup_timeout_ms = std::env::var("ROUTE2_CLASSIFIER_STARTUP_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(self.inner.config.startup_timeout_ms);

        let start = Instant::now();
        let timeout = Duration::from_millis(startup_timeout_ms);
        let poll_interval = Duration::from_millis(50);

        while start.elapsed() < timeout {
            if self.inner.shutdown_requested.load(Ordering::Acquire) {
                terminate_child_tree(&mut child);
                if let Some(handle) = stderr_thread.take() {
                    let _ = handle.join();
                }
                return Err("classifier startup cancelled during shutdown".to_string());
            }
            if let Ok(Some(status)) = child.try_wait() {
                terminate_child_tree(&mut child);
                if let Some(handle) = stderr_thread.take() {
                    let _ = handle.join();
                }
                let error = append_stderr_diagnostic(
                    format!(
                        "local classifier server exited prematurely during cold start with status: {status}"
                    ),
                    &stderr_buffer,
                );
                emit_classifier_lifecycle(
                    "error",
                    "local classifier exited before becoming ready",
                    lifecycle_started,
                );
                return Err(error);
            }

            if is_healthy(&endpoint) {
                capture_startup.store(false, Ordering::Release);
                *child_guard = Some(child);
                self.touch_activity();
                self.start_idle_watchdog();
                emit_classifier_lifecycle("ready", "local classifier ready", lifecycle_started);
                return Ok(());
            }

            std::thread::sleep(poll_interval);
        }

        terminate_child_tree(&mut child);
        if let Some(handle) = stderr_thread.take() {
            let _ = handle.join();
        }
        let error = append_stderr_diagnostic(
            format!(
                "local classifier server failed to respond at '{endpoint}' within {startup_timeout_ms}ms after cold start"
            ),
            &stderr_buffer,
        );
        emit_classifier_lifecycle(
            "error",
            "local classifier did not become ready",
            lifecycle_started,
        );
        Err(error)
    }

    fn start_idle_watchdog(&self) {
        if self.inner.watchdog_running.swap(true, Ordering::AcqRel) {
            return;
        }

        let weak = Arc::downgrade(&self.inner);
        std::thread::spawn(move || idle_watchdog(weak));
    }

    /// Check if idle timeout has elapsed since last activity, and shut down if so.
    pub fn check_idle_timeout(&self) -> bool {
        let idle_timeout_secs = std::env::var("ROUTE2_CLASSIFIER_IDLE_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(self.inner.config.idle_timeout_secs);

        if idle_timeout_secs == 0 {
            return false;
        }

        let is_idle = if let Ok(lock) = self.inner.last_activity.lock() {
            lock.elapsed() >= Duration::from_secs(idle_timeout_secs)
        } else {
            false
        };

        if is_idle {
            self.stop();
            return true;
        }
        false
    }

    /// Manually stop the background child process if running.
    pub fn stop(&self) {
        if let Ok(mut child_guard) = self.inner.child.lock() {
            if let Some(mut child) = child_guard.take() {
                terminate_child_tree(&mut child);
            }
        }
    }

    pub fn shutdown(&self) {
        self.inner.shutdown_requested.store(true, Ordering::Release);
        self.stop();
    }

    /// Check if a managed child process is currently alive.
    pub fn is_child_running(&self) -> bool {
        if let Ok(mut child_guard) = self.inner.child.lock() {
            if let Some(ref mut child) = *child_guard {
                if let Ok(None) = child.try_wait() {
                    return true;
                }
            }
        }
        false
    }

    /// Query the Decision 2.0-compatible backend with a Choice question over
    /// HTTP stdio curl. `task` may be plain text or a structured state summary
    /// serialized as text by a host; it is forwarded as the model state
    /// without requiring a particular JSON shape.
    pub fn call_inference(
        &self,
        task: &str,
        timeout_ms: Option<u64>,
    ) -> Result<(String, f64, String), String> {
        let endpoint = std::env::var("ROUTE2_CLASSIFIER_ENDPOINT")
            .unwrap_or_else(|_| self.inner.config.endpoint.clone());
        let model = &self.inner.config.model;
        let timeout_ms = timeout_ms.unwrap_or(self.inner.config.timeout_ms);

        let criteria = ROUTING_TIER_CRITERIA
            .iter()
            .map(|(tier, description)| {
                (
                    (*tier).to_string(),
                    serde_json::Value::String((*description).to_string()),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let request_payload = serde_json::json!({
            "model": model,
            "state": task,
            "questions": {
                "tier": {
                    "type": "choice",
                    "instructions": ROUTING_DECISION_INSTRUCTIONS,
                    "criteria": criteria
                }
            }
        });

        let payload_str = serde_json::to_string(&request_payload).map_err(|e| e.to_string())?;
        let curl_cmd = "curl";
        let timeout_secs = timeout_ms.div_ceil(1000).max(1);

        let mut command = Command::new(curl_cmd);
        command
            .arg("--fail-with-body")
            .arg("-s")
            .arg("-S")
            .arg("-X")
            .arg("POST")
            .arg(&endpoint)
            .arg("-H")
            .arg("Content-Type: application/json")
            .arg("--connect-timeout")
            .arg("2")
            .arg("--max-time")
            .arg(timeout_secs.to_string())
            .arg("-d")
            .arg(&payload_str);

        let output = command
            .output()
            .map_err(|e| format!("Failed to execute {curl_cmd}: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("curl error {}: {}", output.status, stderr.trim()));
        }

        let body = String::from_utf8_lossy(&output.stdout);
        let json: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("JSON parse: {e}"))?;

        let answer = json
            .get("answers")
            .and_then(|a| a.get("tier"))
            .ok_or_else(|| "Missing 'tier' in System One answers".to_string())?;

        let choice = answer
            .get("choice")
            .and_then(|c| c.as_str())
            .ok_or_else(|| "Missing 'choice' in System One answer".to_string())?
            .to_string();

        let confidence = answer
            .get("confidence")
            .and_then(|c| c.as_f64())
            .ok_or_else(|| "Missing numeric confidence in System One answer".to_string())?;

        if !["small", "semi_big", "large", "safety_sensitive", "decision"]
            .contains(&choice.as_str())
        {
            return Err(format!("Unknown routing tier: {choice}"));
        }
        if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
            return Err("Invalid routing confidence".to_string());
        }

        let rationale = format!(
            "Classified next-step reasoning difficulty by {model} System One decision model (uncalibrated confidence: {confidence:.2})"
        );
        self.touch_activity();
        Ok((choice, confidence, rationale))
    }
}

fn idle_watchdog(weak: Weak<ClassifierManagerInner>) {
    loop {
        std::thread::sleep(Duration::from_millis(250));
        let Some(inner) = weak.upgrade() else {
            return;
        };
        let manager = ClassifierManager {
            inner: Arc::clone(&inner),
        };
        if manager.check_idle_timeout() {
            inner.watchdog_running.store(false, Ordering::Release);
            return;
        }
        if !manager.is_child_running() {
            inner.watchdog_running.store(false, Ordering::Release);
            return;
        }
    }
}
