//! Local reasoning-effort routing for Codex on macOS.
//!
//! Decision 2.0 classifies tasks locally and recommends reasoning effort.
//! The Codex provider applies recommendations; MCP is an internal transport.

#[cfg(not(target_os = "macos"))]
compile_error!("Route2 supports macOS and Codex only");

use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";
pub const POLICY_CONFIG: &str = include_str!("../config/route2.json");
pub const EVENT_SCHEMA_VERSION: &str = "route2.event.v1";

/// Instructions shared by tier discovery and the Decision 2.0 classifier.
///
/// The classifier receives either ordinary task text or a structured state
/// summary serialized as text by a host. Confidence is an uncalibrated model
/// score; it is useful for telemetry, not for a calibrated cutoff.
pub const ROUTING_DECISION_INSTRUCTIONS: &str = "Classify the reasoning difficulty of the next coding step, not the work type. Read the task and, when the state is structured text, use objective, currentphase/current_phase, unresolved, outcomes/recent_tool_outcomes, currenteffort/current_effort, and requestssincedecision/requests_since_decision. Confidence is an uncalibrated model score; do not apply a calibrated threshold. Choose exactly one compatible tier.";

/// Stable response IDs retained for policy and host compatibility.
/// Their descriptions now distinguish the reasoning needed for the next step
/// across coding tasks rather than labeling the kind of work being requested.
pub const ROUTING_TIER_CRITERIA: &[(&str, &str)] = &[
    (
        "small",
        "Low reasoning difficulty: an easy, local, mechanical coding or verification step with clear requirements and known behavior, such as a direct edit, formatting change, or straightforward test. A security topic alone does not require max effort; use this tier when the reasoning is routine.",
    ),
    (
        "semi_big",
        "Medium reasoning difficulty: bounded coding with known logic and a clear acceptance condition, including ordinary debugging, limited integration, or a small set of related tests. Use this when the next step is substantive but the likely path is understood.",
    ),
    (
        "large",
        "High reasoning difficulty: ambiguous requirements, deep invariants, difficult interactions, broad design, repeated substantive failures, or failed hypotheses that require a new investigation. Use this for hard reasoning across coding tasks.",
    ),
    (
        "safety_sensitive",
        "Max reasoning only when security, privacy, credentials, financial, or production risk also demands difficult reasoning to resolve. Topic alone is insufficient; otherwise choose small, semi_big, or large by the reasoning difficulty of the next step.",
    ),
    (
        "decision",
        "Low reasoning demand for a fast classification, categorization, triage, or structured yes/no decision with a clear question.",
    ),
];

pub mod classifier;
pub mod mcp;

pub use classifier::{
    default_classifier_args, default_classifier_command, default_classifier_endpoint,
    default_classifier_model, default_idle_timeout_secs, default_startup_timeout_ms,
    default_timeout_ms, is_healthy, parse_host_port, ClassifierConfig, ClassifierManager,
};

/// Rich operational options for routing requests.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RouteOptions {
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub report_decision_time_ms: bool,
    #[serde(default)]
    pub detail_level: Option<String>,
}

/// Compact representation of a route decision for streamlined client consumption.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompactRouteDecision {
    pub task_class: String,
    pub target_model: String,
    pub recommended_model: String,
    pub recommended_reasoning_effort: String,
    pub window_generations: u32,
    pub confidence: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_time_ms: Option<u64>,
}

impl From<&RouteDecision> for CompactRouteDecision {
    fn from(decision: &RouteDecision) -> Self {
        Self {
            task_class: decision.task_class.clone(),
            target_model: decision.target_model.clone(),
            recommended_model: decision.recommended_model.clone(),
            recommended_reasoning_effort: decision.recommended_reasoning_effort.clone(),
            window_generations: decision.window_generations,
            confidence: decision.confidence,
            decision_time_ms: decision.decision_time_ms,
        }
    }
}

/// Informational tier description for in-session effort discovery.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TierInfo {
    pub name: String,
    pub criteria: String,
    pub target_model: String,
    pub recommended_model: String,
    pub recommended_reasoning_effort: String,
    pub window_generations: u32,
}

/// Complete routing tier catalog returned by discovery tools.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoutingTiersResponse {
    pub active_backend: String,
    pub policy_version: String,
    pub target_model: String,
    pub tiers: Vec<TierInfo>,
}

/// The machine-readable result returned by both the CLI and MCP tool calls.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteDecision {
    pub task_class: String,
    pub target_model: String,
    pub recommended_model: String,
    pub recommended_reasoning_effort: String,
    pub window_generations: u32,
    pub reassessment_triggers: Vec<String>,
    pub confidence: f64,
    pub rationale: String,
    pub policy_version: String,
    pub rule_ids: Vec<String>,
    pub request_id: String,
    pub event_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_time_ms: Option<u64>,
}

pub fn default_reassessment_triggers() -> Vec<String> {
    vec![
        "tool_failure".to_string(),
        "user_input".to_string(),
        "window_expired".to_string(),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TierEffortConfig {
    pub reasoning_effort: String,
    #[serde(default = "default_window_generations")]
    pub window_generations: u32,
}

pub fn default_window_generations() -> u32 {
    1
}

pub fn source_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("ROUTE2_SOURCE_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = exe.parent().and_then(Path::parent) {
            if root.join("scripts").is_dir() {
                return root.to_path_buf();
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EffortPolicyConfig {
    #[serde(default = "default_small_effort")]
    pub small: TierEffortConfig,
    #[serde(default = "default_semi_big_effort")]
    pub semi_big: TierEffortConfig,
    #[serde(default = "default_large_effort")]
    pub large: TierEffortConfig,
    #[serde(default = "default_safety_effort")]
    pub safety_sensitive: TierEffortConfig,
    #[serde(default = "default_decision_effort")]
    pub decision: TierEffortConfig,
}

impl Default for EffortPolicyConfig {
    fn default() -> Self {
        Self {
            small: default_small_effort(),
            semi_big: default_semi_big_effort(),
            large: default_large_effort(),
            safety_sensitive: default_safety_effort(),
            decision: default_decision_effort(),
        }
    }
}

fn default_small_effort() -> TierEffortConfig {
    TierEffortConfig {
        reasoning_effort: "low".to_string(),
        window_generations: 5,
    }
}

fn default_semi_big_effort() -> TierEffortConfig {
    TierEffortConfig {
        reasoning_effort: "medium".to_string(),
        window_generations: 2,
    }
}

fn default_large_effort() -> TierEffortConfig {
    TierEffortConfig {
        reasoning_effort: "high".to_string(),
        window_generations: 1,
    }
}

fn default_safety_effort() -> TierEffortConfig {
    TierEffortConfig {
        reasoning_effort: "max".to_string(),
        window_generations: 1,
    }
}

fn default_decision_effort() -> TierEffortConfig {
    TierEffortConfig {
        reasoning_effort: "low".to_string(),
        window_generations: 5,
    }
}

/// Policy configuration for the Decision 2.0 backend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyConfig {
    pub policy_version: String,
    #[serde(default = "default_backend")]
    pub backend: String,
    #[serde(default = "default_target_model")]
    pub target_model: String,
    #[serde(default)]
    pub decision: Option<ClassifierConfig>,
    #[serde(default)]
    pub effort_policy: Option<EffortPolicyConfig>,
}

fn default_backend() -> String {
    "decision".to_string()
}

pub fn default_target_model() -> String {
    "gpt-6.1-sol".to_string()
}
/// Runtime router holding a validated, immutable policy and Classifier lifecycle manager.
#[derive(Debug, Clone)]
pub struct Router {
    policy: PolicyConfig,
    config_source: Option<PathBuf>,
    classifier_manager: ClassifierManager,
}

#[derive(Debug)]
pub enum PolicyError {
    Parse(serde_json::Error),
    Read { path: PathBuf, source: io::Error },
    Invalid(String),
}

impl fmt::Display for PolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(error) => write!(formatter, "invalid route2 policy JSON: {error}"),
            Self::Read { path, source } => {
                write!(
                    formatter,
                    "unable to read policy {}: {source}",
                    path.display()
                )
            }
            Self::Invalid(message) => write!(formatter, "invalid route2 policy: {message}"),
        }
    }
}

impl std::error::Error for PolicyError {}

impl Router {
    /// Parse a policy from JSON and validate the fields needed for stable
    /// routing. The policy remains pure data; no code is evaluated from it.
    pub fn from_json(policy_json: &str) -> Result<Self, PolicyError> {
        let policy: PolicyConfig = serde_json::from_str(policy_json).map_err(PolicyError::Parse)?;
        validate_policy(&policy)?;
        let classifier_cfg = policy.decision.clone().ok_or_else(|| {
            PolicyError::Invalid("decision backend requires decision configuration".into())
        })?;
        let classifier_manager = ClassifierManager::new(classifier_cfg);
        Ok(Self {
            policy,
            config_source: None,
            classifier_manager,
        })
    }

    /// Auto-discover the configuration path based on workspace and user locations.
    pub fn discover_config_path(explicit_path: Option<&Path>) -> Option<PathBuf> {
        if let Some(path) = explicit_path {
            return Some(path.to_path_buf());
        }
        if let Some(env_path) = std::env::var_os("ROUTE2_CONFIG") {
            let p = PathBuf::from(env_path);
            if p.exists() {
                return Some(p);
            }
        }
        let ws_route2_config = Path::new(".route2").join("config.json");
        if ws_route2_config.exists() {
            return Some(ws_route2_config);
        }
        let ws_route2_dot = Path::new(".route2.json");
        if ws_route2_dot.exists() {
            return Some(ws_route2_dot.to_path_buf());
        }
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            let home_config = PathBuf::from(home).join(".route2").join("config.json");
            if home_config.exists() {
                return Some(home_config);
            }
        }
        None
    }

    /// Load a policy from an explicit path or auto-discovered configuration,
    /// falling back to the built-in policy.
    pub fn load(path: Option<&Path>) -> Result<Self, PolicyError> {
        let discovered = Self::discover_config_path(path);
        let router = match discovered {
            Some(ref p) => {
                let policy_json =
                    std::fs::read_to_string(p).map_err(|source| PolicyError::Read {
                        path: p.clone(),
                        source,
                    })?;
                let mut r = Self::from_json(&policy_json)?;
                r.config_source = Some(p.clone());
                r
            }
            None => Self::from_json(POLICY_CONFIG)?,
        };

        Ok(router)
    }

    /// Access the underlying ClassifierManager for cold-start and timeout management.
    pub fn classifier_manager(&self) -> &ClassifierManager {
        &self.classifier_manager
    }

    /// Ensure the local classifier server is running; cold-starts it if offline.
    pub fn ensure_classifier_running(&self) -> Result<(), String> {
        self.classifier_manager.ensure_running()
    }

    /// Check if idle timeout has expired and auto-stop the server if needed.
    pub fn check_classifier_idle_timeout(&self) -> bool {
        self.classifier_manager.check_idle_timeout()
    }

    /// Stop the background local classifier process.
    pub fn stop_classifier(&self) {
        self.classifier_manager.stop();
    }

    /// Expose the path from which the policy was loaded, if not built-in.
    pub fn config_source(&self) -> Option<&Path> {
        self.config_source.as_deref()
    }

    /// Access the underlying validated policy configuration.
    pub fn policy(&self) -> &PolicyConfig {
        &self.policy
    }

    /// Expose the active policy version for logs and diagnostics.
    pub fn policy_version(&self) -> &str {
        &self.policy.policy_version
    }

    pub fn backend_name(&self) -> String {
        self.policy.backend.clone()
    }

    pub fn target_model(&self) -> &str {
        if self.policy.target_model.is_empty() {
            "gpt-6.1-sol"
        } else {
            &self.policy.target_model
        }
    }

    pub fn resolve_tier_effort(&self, tier: &str) -> (String, u32) {
        if let Some(policy) = &self.policy.effort_policy {
            match tier {
                "small" => (
                    policy.small.reasoning_effort.clone(),
                    policy.small.window_generations,
                ),
                "semi_big" => (
                    policy.semi_big.reasoning_effort.clone(),
                    policy.semi_big.window_generations,
                ),
                "large" => (
                    policy.large.reasoning_effort.clone(),
                    policy.large.window_generations,
                ),
                "safety_sensitive" => (
                    policy.safety_sensitive.reasoning_effort.clone(),
                    policy.safety_sensitive.window_generations,
                ),
                "decision" => (
                    policy.decision.reasoning_effort.clone(),
                    policy.decision.window_generations,
                ),
                _ => (
                    policy.semi_big.reasoning_effort.clone(),
                    policy.semi_big.window_generations,
                ),
            }
        } else {
            match tier {
                "small" => ("low".to_string(), 5),
                "semi_big" => ("medium".to_string(), 2),
                "large" => ("high".to_string(), 1),
                "safety_sensitive" => ("max".to_string(), 1),
                "decision" => ("low".to_string(), 5),
                _ => ("medium".to_string(), 2),
            }
        }
    }

    pub fn resolve_tier_roster(&self, tier: &str) -> (String, String) {
        let (effort, _) = self.resolve_tier_effort(tier);
        (self.target_model().to_string(), effort)
    }

    /// Two-stage discovery: inspect available tiers, criteria, and model roster.
    pub fn get_routing_tiers(&self, filter_tier: Option<&str>) -> RoutingTiersResponse {
        let tiers: Vec<TierInfo> = ROUTING_TIER_CRITERIA
            .iter()
            .filter(|(name, _)| {
                if let Some(filter) = filter_tier {
                    name.eq_ignore_ascii_case(filter)
                } else {
                    true
                }
            })
            .map(|(name, criteria)| {
                let (recommended_reasoning_effort, window_generations) =
                    self.resolve_tier_effort(name);
                TierInfo {
                    name: (*name).to_string(),
                    criteria: (*criteria).to_string(),
                    target_model: self.target_model().to_string(),
                    recommended_model: self.target_model().to_string(),
                    recommended_reasoning_effort,
                    window_generations,
                }
            })
            .collect();

        RoutingTiersResponse {
            active_backend: self.backend_name(),
            policy_version: self.policy.policy_version.clone(),
            target_model: self.target_model().to_string(),
            tiers,
        }
    }

    /// Route a task with default options.
    pub fn route(&self, task: &str) -> RouteDecision {
        self.route_with_options(task, &RouteOptions::default())
    }

    /// Route a task with rich operational options (timeout, timing report, detail level).
    pub fn route_with_options(&self, task: &str, options: &RouteOptions) -> RouteDecision {
        let start_time = Instant::now();
        let normalized = task.trim();
        let request_id = format!("route2-{:016x}", fnv1a64(normalized.as_bytes()));
        let event_id = format!(
            "evt-{:016x}",
            fnv1a64(format!("{}:{}", self.policy.policy_version, request_id).as_bytes())
        );

        if normalized.is_empty() {
            let (rec_effort, window) = self.resolve_tier_effort("small");
            return RouteDecision {
                task_class: "small".to_string(),
                target_model: self.target_model().to_string(),
                recommended_model: self.target_model().to_string(),
                recommended_reasoning_effort: rec_effort,
                window_generations: window,
                reassessment_triggers: default_reassessment_triggers(),
                confidence: 0.0,
                rationale: "Empty task description; valid task input required for classification."
                    .to_string(),
                policy_version: self.policy.policy_version.clone(),
                rule_ids: vec![format!("{}.empty_input", self.backend_name())],
                request_id,
                event_id,
                decision_time_ms: if options.report_decision_time_ms {
                    Some(start_time.elapsed().as_millis() as u64)
                } else {
                    None
                },
            };
        }

        // Query the Decision 2.0 classifier (auto cold-starts if offline).
        let classifier_cfg = self.classifier_manager.config();
        if let Err(e) = self.classifier_manager.ensure_running() {
            return RouteDecision {
                task_class: "error".to_string(),
                target_model: String::new(),
                recommended_model: String::new(),
                recommended_reasoning_effort: String::new(),
                window_generations: 0,
                reassessment_triggers: Vec::new(),
                confidence: 0.0,
                rationale: format!("Decision server unavailable: {e}"),
                policy_version: self.policy.policy_version.clone(),
                rule_ids: vec![format!(
                    "{}.{}.unavailable",
                    self.backend_name(),
                    classifier_cfg.model
                )],
                request_id,
                event_id,
                decision_time_ms: if options.report_decision_time_ms {
                    Some(start_time.elapsed().as_millis() as u64)
                } else {
                    None
                },
            };
        }

        match self
            .classifier_manager
            .call_inference(normalized, options.timeout_ms)
        {
            Ok((tier, confidence, rationale)) => {
                let (recommended_reasoning_effort, window_generations) =
                    self.resolve_tier_effort(&tier);
                RouteDecision {
                    task_class: tier,
                    target_model: self.target_model().to_string(),
                    recommended_model: self.target_model().to_string(),
                    recommended_reasoning_effort,
                    window_generations,
                    reassessment_triggers: default_reassessment_triggers(),
                    confidence: normalize_confidence(confidence),
                    rationale,
                    policy_version: self.policy.policy_version.clone(),
                    rule_ids: vec![format!("{}.{}", self.backend_name(), classifier_cfg.model)],
                    request_id,
                    event_id,
                    decision_time_ms: if options.report_decision_time_ms {
                        Some(start_time.elapsed().as_millis() as u64)
                    } else {
                        None
                    },
                }
            }
            Err(e) => RouteDecision {
                task_class: "error".to_string(),
                target_model: String::new(),
                recommended_model: String::new(),
                recommended_reasoning_effort: String::new(),
                window_generations: 0,
                reassessment_triggers: Vec::new(),
                confidence: 0.0,
                rationale: format!("Decision inference failed: {e}"),
                policy_version: self.policy.policy_version.clone(),
                rule_ids: vec![format!(
                    "{}.{}.error",
                    self.backend_name(),
                    classifier_cfg.model
                )],
                request_id,
                event_id,
                decision_time_ms: if options.report_decision_time_ms {
                    Some(start_time.elapsed().as_millis() as u64)
                } else {
                    None
                },
            },
        }
    }
}

impl Default for Router {
    fn default() -> Self {
        Self::from_json(POLICY_CONFIG).expect("built-in route2 policy must be valid")
    }
}

/// Route using the built-in policy.
pub fn route(task: &str) -> RouteDecision {
    Router::default().route(task)
}

pub fn validate_policy(policy: &PolicyConfig) -> Result<(), PolicyError> {
    if policy.policy_version.trim().is_empty() {
        return Err(PolicyError::Invalid(
            "policy_version must not be empty".to_string(),
        ));
    }
    let backend = policy.backend.as_str();
    if backend != "decision" {
        return Err(PolicyError::Invalid(format!(
            "backend must be 'decision', found '{backend}'"
        )));
    }
    let config = policy.decision.as_ref().ok_or_else(|| {
        PolicyError::Invalid("decision backend requires decision configuration".into())
    })?;
    if config.model.trim().is_empty()
        || config.command.trim().is_empty()
        || !config.endpoint.starts_with("http://127.0.0.1:")
    {
        return Err(PolicyError::Invalid(
            "decision requires a model, command, and loopback HTTP endpoint".into(),
        ));
    }
    if let Some(effort) = &policy.effort_policy {
        validate_effort_config(&effort.small, "effort_policy.small")?;
        validate_effort_config(&effort.semi_big, "effort_policy.semi_big")?;
        validate_effort_config(&effort.large, "effort_policy.large")?;
        validate_effort_config(&effort.safety_sensitive, "effort_policy.safety_sensitive")?;
        validate_effort_config(&effort.decision, "effort_policy.decision")?;
    }
    Ok(())
}

fn validate_effort_config(config: &TierEffortConfig, field: &str) -> Result<(), PolicyError> {
    if config.reasoning_effort.trim().is_empty() {
        return Err(PolicyError::Invalid(format!(
            "{field} reasoning_effort must not be empty"
        )));
    }
    if config.window_generations == 0 {
        return Err(PolicyError::Invalid(format!(
            "{field} window_generations must be greater than 0"
        )));
    }
    Ok(())
}

fn normalize_confidence(confidence: f64) -> f64 {
    if !confidence.is_finite() {
        return 0.5;
    }
    confidence.clamp(0.0, 1.0)
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3u64);
    }
    hash
}

/// Standardized event schema emitted by route2 to local JSONL logs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteEvent {
    pub event_schema: String,
    pub event_type: String,
    pub observed_at_unix_ms: u128,
    pub source: String,
    pub task_chars: usize,
    pub task_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    pub task_class: String,
    pub recommended_model: String,
    pub recommended_reasoning_effort: String,
    pub confidence: f64,
    pub rationale: String,
    pub policy_version: String,
    pub rule_ids: Vec<String>,
    pub request_id: String,
    pub event_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_time_ms: Option<u64>,
}

/// Optional append-only JSONL logger.
#[derive(Debug, Clone, Default)]
pub struct EventLogger {
    path: Option<PathBuf>,
    include_task: bool,
}

impl EventLogger {
    pub fn disabled() -> Self {
        Self::default()
    }

    pub fn new(path: Option<PathBuf>, include_task: bool) -> Self {
        Self { path, include_task }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn record(&self, source: &str, task: &str, decision: &RouteDecision) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };

        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        let observed_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let event = RouteEvent {
            event_schema: EVENT_SCHEMA_VERSION.to_string(),
            event_type: "route_decision".to_string(),
            observed_at_unix_ms,
            source: source.to_string(),
            task_chars: task.chars().count(),
            task_fingerprint: format!("task-{:016x}", fnv1a64(task.trim().as_bytes())),
            task: self.include_task.then(|| task.trim().to_string()),
            task_class: decision.task_class.clone(),
            recommended_model: decision.recommended_model.clone(),
            recommended_reasoning_effort: decision.recommended_reasoning_effort.clone(),
            confidence: decision.confidence,
            rationale: decision.rationale.clone(),
            policy_version: decision.policy_version.clone(),
            rule_ids: decision.rule_ids.clone(),
            request_id: decision.request_id.clone(),
            event_id: decision.event_id.clone(),
            decision_time_ms: decision.decision_time_ms,
        };
        serde_json::to_writer(&mut file, &event)
            .map_err(|error| io::Error::other(format!("serialize route2 event: {error}")))?;
        file.write_all(b"\n")
    }
}

pub fn event_logger_from_env() -> EventLogger {
    let path = std::env::var_os("ROUTE2_EVENT_LOG").map(PathBuf::from);
    let include_task = std::env::var("ROUTE2_EVENT_INCLUDE_TASK")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(false);
    EventLogger::new(path, include_task)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_router_loads_and_has_version() {
        let router = Router::default();
        assert_eq!(router.policy_version(), "route2-v0.1.0");
        assert_eq!(router.backend_name(), "decision");
        assert_eq!(router.target_model(), "gpt-6.1-sol");
    }

    #[test]
    fn empty_input_uses_explicit_classifier_empty_input_decision() {
        let result = route("  ");
        assert_eq!(result.task_class, "small");
        assert_eq!(result.target_model, "gpt-6.1-sol");
        assert_eq!(result.recommended_reasoning_effort, "low");
        assert_eq!(result.window_generations, 5);
        assert_eq!(result.rule_ids, vec!["decision.empty_input"]);
    }

    #[test]
    fn ids_are_stable_for_same_task_and_policy() {
        assert_eq!(fnv1a64(b"hello"), fnv1a64(b"hello"));
        assert_ne!(fnv1a64(b"hello"), fnv1a64(b"goodbye"));
    }

    #[test]
    fn custom_policy_can_be_loaded_with_codex_models() {
        let json = r#"{
            "policy_version":"test-v1",
            "backend":"decision",
            "decision":{}
        }"#;
        let router = Router::from_json(json).expect("policy parses");
        assert_eq!(router.backend_name(), "decision");
        let result = router.route("  ");
        assert_eq!(result.target_model, "gpt-6.1-sol");
        assert_eq!(result.recommended_reasoning_effort, "low");
    }

    #[test]
    fn policy_rejects_invalid_backend() {
        let json = r#"{
            "policy_version":"test-v1",
            "backend":"invalid_backend"
        }"#;
        let error = Router::from_json(json).expect_err("invalid backend must fail");
        assert!(error.to_string().contains("backend must be 'decision'"));
    }

    #[test]
    fn effort_policy_resolves_tiers_and_windows() {
        let router = Router::default();
        let (small_effort, small_window) = router.resolve_tier_effort("small");
        assert_eq!(small_effort, "low");
        assert_eq!(small_window, 5);

        let (semi_effort, semi_window) = router.resolve_tier_effort("semi_big");
        assert_eq!(semi_effort, "medium");
        assert_eq!(semi_window, 2);

        let (large_effort, large_window) = router.resolve_tier_effort("large");
        assert_eq!(large_effort, "high");
        assert_eq!(large_window, 1);
    }

    #[test]
    fn get_routing_tiers_catalog() {
        let router = Router::default();
        let tiers_info = router.get_routing_tiers(None);
        assert_eq!(tiers_info.tiers.len(), 5);
        assert_eq!(tiers_info.tiers[0].name, "small");
        assert_eq!(tiers_info.tiers[0].target_model, "gpt-6.1-sol");
        assert_eq!(tiers_info.tiers[0].recommended_reasoning_effort, "low");
        assert_eq!(tiers_info.tiers[0].window_generations, 5);

        let filtered = router.get_routing_tiers(Some("safety_sensitive"));
        assert_eq!(filtered.tiers.len(), 1);
        assert_eq!(filtered.tiers[0].name, "safety_sensitive");
        assert_eq!(filtered.tiers[0].recommended_reasoning_effort, "max");
        assert_eq!(filtered.tiers[0].window_generations, 1);
    }

    #[test]
    fn route_options_records_decision_time() {
        let router = Router::from_json(r#"{"policy_version":"timing-test","backend":"decision","decision":{"endpoint":"http://127.0.0.1:1/v1/systemone","command":"route2-missing-command","args":[]}}"#).unwrap();
        let options = RouteOptions {
            timeout_ms: Some(100),
            report_decision_time_ms: true,
            detail_level: Some("full".to_string()),
        };
        let decision = router.route_with_options("some task", &options);
        assert!(decision.decision_time_ms.is_some());
    }

    #[test]
    fn test_classifier_manager_cold_start_and_idle_timeout() {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().unwrap().port();
        let endpoint = format!("http://127.0.0.1:{port}/v1/systemone");

        drop(listener);
        assert!(!is_healthy(&endpoint));

        let config = ClassifierConfig {
            endpoint: endpoint.clone(),
            idle_timeout_secs: 1,
            startup_timeout_ms: 3000,
            ..ClassifierConfig::default()
        };

        let manager = ClassifierManager::new(config);
        assert!(!manager.is_child_running());
        assert!(!manager.check_idle_timeout());
    }
}
