use route2::{
    mcp::handle_request, EventLogger, Router, DEFAULT_PROTOCOL_VERSION, EVENT_SCHEMA_VERSION,
};
use serde_json::json;

#[test]
fn test_core_router_initialization() {
    let router = Router::default();
    assert_eq!(router.policy_version(), "route2-v0.1.0");
    assert_eq!(router.backend_name(), "decision");
    assert_eq!(router.target_model(), "gpt-6.1-sol");
}

fn unavailable_classifier_router() -> Router {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("ephemeral port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    Router::from_json(&format!(
        r#"{{"policy_version":"test","backend":"decision","decision":{{"endpoint":"http://127.0.0.1:{port}/v1/systemone","command":"route2-missing-classifier-command","args":[]}}}}"#,
    ))
    .expect("valid test policy")
}

#[test]
fn test_core_routing_failure_returns_no_recommendation() {
    let router = unavailable_classifier_router();
    let decision = router.route("Fix typo in README documentation");
    assert_eq!(decision.task_class, "error");
    assert!(decision.recommended_model.is_empty());
    assert!(!decision.request_id.is_empty());
    assert!(!decision.event_id.is_empty());
    assert_eq!(decision.confidence, 0.0);
    assert!(!decision.rationale.is_empty());

    // Deterministic ID generation
    let decision_repeat = router.route("Fix typo in README documentation");
    assert_eq!(decision.request_id, decision_repeat.request_id);
    assert_eq!(decision.event_id, decision_repeat.event_id);
    assert_eq!(
        decision.recommended_model,
        decision_repeat.recommended_model
    );
}

#[test]
fn test_core_routing_empty_input() {
    let router = Router::default();
    let decision = router.route("");
    assert_eq!(decision.task_class, "small");
    assert_eq!(decision.rule_ids, vec!["decision.empty_input"]);
}

#[test]
fn test_core_mcp_initialize() {
    let req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": DEFAULT_PROTOCOL_VERSION
        }
    });
    let res = handle_request(
        &req,
        &unavailable_classifier_router(),
        &EventLogger::disabled(),
    )
    .expect("initialize response");
    assert_eq!(res["jsonrpc"], "2.0");
    assert_eq!(res["id"], 1);
    assert_eq!(res["result"]["serverInfo"]["name"], "route2");
    assert_eq!(res["result"]["protocolVersion"], DEFAULT_PROTOCOL_VERSION);
}

#[test]
fn test_core_mcp_tools_list() {
    let req = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    });
    let res = handle_request(
        &req,
        &unavailable_classifier_router(),
        &EventLogger::disabled(),
    )
    .expect("tools list response");
    let tools = res["result"]["tools"].as_array().expect("tools array");
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
        .collect();

    assert!(names.contains(&"route"));
    assert!(names.contains(&"classify"));
    assert!(names.contains(&"get_routing_tiers"));
}

#[test]
fn test_core_mcp_tool_call() {
    let req = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "route",
            "arguments": {
                "task": "Implement an async queue worker with redis backend"
            }
        }
    });
    let res = handle_request(
        &req,
        &unavailable_classifier_router(),
        &EventLogger::disabled(),
    )
    .expect("tool call response");
    assert_eq!(res["jsonrpc"], "2.0");
    assert_eq!(res["id"], 3);
    assert!(res["result"]["content"].is_array());
    let structured = &res["result"]["structuredContent"];
    assert_eq!(res["result"]["isError"], true);
    assert_eq!(structured["task_class"], "error");
    assert!(structured["recommended_model"].as_str().unwrap().is_empty());
}

#[test]
fn test_core_mcp_get_routing_tiers_call() {
    let req = json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "tools/call",
        "params": {
            "name": "get_routing_tiers",
            "arguments": {
                "tier": "small"
            }
        }
    });
    let res = handle_request(
        &req,
        &unavailable_classifier_router(),
        &EventLogger::disabled(),
    )
    .expect("tool call response");
    assert_eq!(res["jsonrpc"], "2.0");
    assert_eq!(res["id"], 4);
    let structured = &res["result"]["structuredContent"];
    assert_eq!(structured["tiers"].as_array().unwrap().len(), 1);
    assert_eq!(structured["tiers"][0]["name"], "small");
}

#[test]
fn test_core_mcp_route_compact_and_timing() {
    let req = json!({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "tools/call",
        "params": {
            "name": "route",
            "arguments": {
                "task": "Fix security token leak in auth handler",
                "report_decision_time_ms": true,
                "detail_level": "compact"
            }
        }
    });
    let res = handle_request(
        &req,
        &unavailable_classifier_router(),
        &EventLogger::disabled(),
    )
    .expect("compact tool call response");
    let structured = &res["result"]["structuredContent"];
    assert!(structured.get("task_class").is_some());
    assert!(structured.get("recommended_model").is_some());
    assert!(structured.get("decision_time_ms").is_some());
    assert_eq!(res["result"]["isError"], true);
    assert!(structured.get("rationale").is_some());
}

#[test]
fn test_core_rejects_non_decision_backend() {
    let policy_json = r#"{
        "policy_version": "backend-test-v1",
        "backend": "unsupported"
    }"#;
    let error = Router::from_json(policy_json).expect_err("non-Decision backend must fail");
    assert!(error.to_string().contains("backend must be 'decision'"));
}

#[test]
fn test_core_custom_policy_loading() {
    let router = Router::from_json(route2::POLICY_CONFIG).expect("router from valid policy");
    assert_eq!(router.policy_version(), "route2-v0.1.0");
}

#[test]
fn test_core_event_schema_version() {
    assert_eq!(EVENT_SCHEMA_VERSION, "route2.event.v1");
}

#[test]
fn test_core_classifier_cold_start_and_idle_timeout() {
    let router = Router::default();
    let manager = router.classifier_manager();
    assert!(!manager.is_child_running());
    assert!(!manager.check_idle_timeout());
}
