//! Internal newline-delimited JSON-RPC/MCP adapter for the Codex provider.

use crate::{
    CompactRouteDecision, EventLogger, RouteDecision, RouteOptions, Router,
    DEFAULT_PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];

/// Run the MCP server over stdin/stdout.  Diagnostics are sent only to stderr;
/// stdout remains a clean JSON-RPC stream for the host process.
pub fn run_stdio(router: &Router, logger: &EventLogger) -> io::Result<()> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let classifier = router.classifier_manager().clone();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            if sender.send(line).is_err() {
                break;
            }
        }
        classifier.shutdown();
    });
    let mut stdout = io::BufWriter::new(io::stdout().lock());

    for line in receiver {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<Value>(&line) {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    &mut stdout,
                    &json_rpc_error(Value::Null, -32700, &format!("Parse error: {error}")),
                )?;
                continue;
            }
        };

        let should_exit = request.get("method").and_then(Value::as_str) == Some("exit");
        if let Some(response) = handle_request(&request, router, logger) {
            write_response(&mut stdout, &response)?;
        }
        if should_exit {
            router.classifier_manager().shutdown();
            break;
        }
    }
    Ok(())
}

fn write_response(stdout: &mut impl Write, response: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *stdout, response)
        .map_err(|error| io::Error::other(format!("serialize MCP response: {error}")))?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

/// Handle one parsed JSON-RPC request.  Notifications intentionally return
/// `None`, as required by JSON-RPC and expected by MCP hosts.
pub fn handle_request(request: &Value, router: &Router, logger: &EventLogger) -> Option<Value> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let has_id = request.get("id").is_some();

    if !has_id && (method.starts_with("notifications/") || method == "initialized") {
        return None;
    }

    match method {
        "initialize" => {
            let requested_version = request
                .get("params")
                .and_then(|params| params.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_PROTOCOL_VERSION);
            let protocol_version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested_version) {
                requested_version
            } else {
                DEFAULT_PROTOCOL_VERSION
            };
            Some(json_rpc_result(
                id,
                json!({
                    "protocolVersion": protocol_version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {
                        "name": "route2",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "instructions": "Use route for actionable deterministic model and reasoning recommendations. The route is local and does not make provider calls; the caller remains responsible for user instructions, safety, and tool permissions."
                }),
            ))
        }
        "notifications/initialized" | "notifications/cancelled" | "notifications/progress" => None,
        "ping" => Some(json_rpc_result(id, json!({}))),
        "shutdown" => Some(json_rpc_result(id, Value::Null)),
        "tools/list" => Some(json_rpc_result(id, tools_list())),
        "tools/call" => Some(handle_tool_call(id, request, router, logger)),
        _ if !has_id => None,
        _ => Some(json_rpc_error(
            id,
            -32601,
            &format!("Method not found: {method}"),
        )),
    }
}

fn tools_list() -> Value {
    json!({
        "tools": [
            json!({
                "name": "get_routing_tiers",
                "description": "Inspect available routing tiers, their classification criteria, mapped model recommendations, reasoning effort, and active backend capabilities before routing tasks.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tier": {
                            "type": "string",
                            "description": "Optional tier name to filter (e.g. 'small', 'semi_big', 'large', 'safety_sensitive', 'decision')."
                        }
                    },
                    "additionalProperties": false
                },
                "outputSchema": {
                    "type": "object",
                    "properties": {
                        "active_backend": {"type": "string"},
                        "policy_version": {"type": "string"},
                        "tiers": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "criteria": {"type": "string"},
                                    "target_model": {"type": "string"},
                                    "recommended_model": {"type": "string"},
                                    "recommended_reasoning_effort": {"type": "string"},
                                    "window_generations": {"type": "integer"}
                                },
                                "required": ["name", "criteria", "recommended_model", "recommended_reasoning_effort"]
                            }
                        },
                    },
                    "required": ["active_backend", "policy_version", "tiers"],
                    "additionalProperties": false
                }
            }),
            tool_definition(
                "route",
                "Classify a task with the configured decision backend and return recommended reasoning effort, generation window, and reassessment triggers. The host must apply the recommendation; this tool does not change host settings or guarantee cache hits.",
            ),
            tool_definition(
                "classify",
                "Compatibility alias for route. Return in-session reasoning effort recommendation and generation window.",
            )
        ]
    })
}

fn tool_definition(name: &str, description: &str) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "The complete task text to route."
                },
                "report_decision_time_ms": {
                    "type": "boolean",
                    "description": "Whether to measure and report routing decision time in milliseconds."
                },
                "detail_level": {
                    "type": "string",
                    "enum": ["full", "compact"],
                    "description": "Output detail level: 'full' returns complete routing decision; 'compact' returns essential tier and model recommendations only."
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Optional override for backend decision timeout in milliseconds."
                }
            },
            "required": ["task"],
            "additionalProperties": false
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "task_class": {"type": "string"},
                "target_model": {"type": "string"},
                "recommended_model": {"type": "string"},
                "recommended_reasoning_effort": {"type": "string"},
                "window_generations": {"type": "integer"},
                "reassessment_triggers": {"type": "array", "items": {"type": "string"}},
                "confidence": {"type": "number"},
                "rationale": {"type": "string"},
                "policy_version": {"type": "string"},
                "rule_ids": {"type": "array", "items": {"type": "string"}},
                                "request_id": {"type": "string"},
                "event_id": {"type": "string"},
                "decision_time_ms": {"type": "number"}
            },
            "required": [
                "task_class",
                "recommended_model",
                "recommended_reasoning_effort"
            ],
            "additionalProperties": true
        }
    })
}

fn handle_tool_call(id: Value, request: &Value, router: &Router, logger: &EventLogger) -> Value {
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");

    if name == "get_routing_tiers" {
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let tier_filter = arguments.get("tier").and_then(Value::as_str);
        let tiers_response = router.get_routing_tiers(tier_filter);
        let structured =
            serde_json::to_value(&tiers_response).expect("tiers response is serializable");
        let text =
            serde_json::to_string_pretty(&tiers_response).expect("tiers response is serializable");
        return json_rpc_result(
            id,
            json!({
                "content": [{"type": "text", "text": text}],
                "structuredContent": structured,
                "isError": false
            }),
        );
    }

    if name != "route" && name != "classify" {
        return json_rpc_error(
            id,
            -32602,
            "Unknown tool; expected get_routing_tiers, route, or classify",
        );
    }

    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let Some(task) = arguments.get("task").and_then(Value::as_str) else {
        return json_rpc_error(id, -32602, "arguments.task must be a string");
    };

    let report_decision_time_ms = arguments
        .get("report_decision_time_ms")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let detail_level = arguments
        .get("detail_level")
        .and_then(Value::as_str)
        .unwrap_or("full");
    let timeout_ms = arguments.get("timeout_ms").and_then(Value::as_u64);

    let options = RouteOptions {
        timeout_ms,
        report_decision_time_ms,
        detail_level: Some(detail_level.to_string()),
    };

    let decision = router.route_with_options(task, &options);
    if let Err(error) = logger.record("mcp", task, &decision) {
        eprintln!("route2: event log write failed: {error}");
    }

    if decision.task_class == "error" {
        let structured = serde_json::to_value(&decision).expect("error decision is serializable");
        return json_rpc_result(
            id,
            json!({
                "content": [{"type": "text", "text": decision.rationale}],
                "structuredContent": structured,
                "isError": true
            }),
        );
    }

    if detail_level == "compact" {
        let compact = CompactRouteDecision::from(&decision);
        let structured =
            serde_json::to_value(&compact).expect("compact route decision is serializable");
        let text = serde_json::to_string(&compact).expect("compact route decision is serializable");
        return json_rpc_result(
            id,
            json!({
                "content": [{"type": "text", "text": text}],
                "structuredContent": structured,
                "isError": false
            }),
        );
    }

    tool_result(id, &decision)
}

fn tool_result(id: Value, decision: &RouteDecision) -> Value {
    let structured = serde_json::to_value(decision).expect("route decision is serializable");
    let text = serde_json::to_string(decision).expect("route decision is serializable");
    json_rpc_result(
        id,
        json!({
            "content": [{"type": "text", "text": text}],
            "structuredContent": structured,
            "isError": false
        }),
    )
}

fn json_rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn json_rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn router_with_mock_classifier(choice: &str) -> Router {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock classifier listener");
        let port = listener.local_addr().expect("listener address").port();
        let choice = choice.to_string();
        std::thread::spawn(move || {
            for request_number in 0..2 {
                let (mut stream, _) = listener.accept().expect("mock classifier connection");
                if request_number == 0 {
                    continue;
                }
                let mut request = [0_u8; 8192];
                let _ = stream.read(&mut request);
                let body = format!(
                    r#"{{"answers":{{"tier":{{"choice":"{choice}","confidence":0.91}}}}}}"#
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("mock classifier response");
            }
        });
        Router::from_json(&format!(
            r#"{{"policy_version":"test","backend":"decision","decision":{{"endpoint":"http://127.0.0.1:{port}/v1/systemone"}}}}"#
        ))
        .expect("mock classifier policy")
    }

    #[test]
    fn initialize_advertises_route2() {
        let response = handle_request(
            &json!({
                "jsonrpc":"2.0",
                "id":1,
                "method":"initialize",
                "params":{"protocolVersion":"2025-06-18"}
            }),
            &Router::default(),
            &EventLogger::disabled(),
        )
        .expect("initialize has a response");
        assert_eq!(response["result"]["serverInfo"]["name"], "route2");
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
    }

    #[test]
    fn tools_list_contains_route_and_compatibility_alias() {
        let response = handle_request(
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            &Router::default(),
            &EventLogger::disabled(),
        )
        .expect("tools/list has a response");
        assert_eq!(response["result"]["tools"][0]["name"], "get_routing_tiers");
        assert_eq!(response["result"]["tools"][1]["name"], "route");
        assert_eq!(response["result"]["tools"][2]["name"], "classify");
    }

    #[test]
    fn tool_call_returns_actionable_structured_route() {
        let router = router_with_mock_classifier("small");
        let response = handle_request(
            &json!({
                "jsonrpc":"2.0",
                "id":"call-1",
                "method":"tools/call",
                "params":{"name":"route","arguments":{"task":"Summarize this."}}
            }),
            &router,
            &EventLogger::disabled(),
        )
        .expect("tools/call has a response");
        assert_eq!(response["result"]["isError"], false);
        assert!(
            !response["result"]["structuredContent"]["recommended_model"]
                .as_str()
                .unwrap()
                .is_empty()
        );
        assert!(!response["result"]["structuredContent"]["task_class"]
            .as_str()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn get_routing_tiers_tool_call() {
        let response = handle_request(
            &json!({
                "jsonrpc":"2.0",
                "id":"call-tiers",
                "method":"tools/call",
                "params":{"name":"get_routing_tiers","arguments":{}}
            }),
            &Router::default(),
            &EventLogger::disabled(),
        )
        .expect("get_routing_tiers has a response");
        assert_eq!(response["result"]["isError"], false);
        let tiers = response["result"]["structuredContent"]["tiers"]
            .as_array()
            .unwrap();
        assert_eq!(tiers.len(), 5);
    }

    #[test]
    fn tool_call_supports_detail_level_compact() {
        let router = router_with_mock_classifier("small");
        let response = handle_request(
            &json!({
                "jsonrpc":"2.0",
                "id":"call-compact",
                "method":"tools/call",
                "params":{"name":"route","arguments":{"task":"Quick fix","detail_level":"compact"}}
            }),
            &router,
            &EventLogger::disabled(),
        )
        .expect("compact call has a response");
        assert_eq!(response["result"]["isError"], false);
        let structured = &response["result"]["structuredContent"];
        assert!(structured.get("task_class").is_some());
        assert!(structured.get("recommended_model").is_some());
        assert!(structured.get("rationale").is_none());
    }

    #[test]
    fn tool_call_supports_timing_report() {
        let router = router_with_mock_classifier("semi_big");
        let response = handle_request(
            &json!({
                "jsonrpc":"2.0",
                "id":"call-timing",
                "method":"tools/call",
                "params":{"name":"route","arguments":{"task":"Summarize code","report_decision_time_ms":true}}
            }),
            &router,
            &EventLogger::disabled(),
        )
        .expect("timing call has a response");
        assert_eq!(response["result"]["isError"], false);
        let structured = &response["result"]["structuredContent"];
        assert!(structured.get("decision_time_ms").is_some());
    }

    #[test]
    fn notifications_do_not_receive_responses() {
        let response = handle_request(
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            &Router::default(),
            &EventLogger::disabled(),
        );
        assert!(response.is_none());
    }
}
