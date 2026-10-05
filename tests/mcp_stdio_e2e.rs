use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};

/// Full end-to-end integration test of the route2 stdio MCP server,
/// verifying protocol lifecycle and routing tool invocations.
#[test]
fn test_mcp_stdio_lifecycle_and_tools() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("mock classifier listener");
    let port = listener.local_addr().unwrap().port();
    let mock = std::thread::spawn(move || {
        for request_number in 0..2 {
            let (mut stream, _) = listener.accept().expect("mock classifier connection");
            if request_number == 0 {
                continue;
            }
            let mut request = [0_u8; 8192];
            let _ = stream.read(&mut request);
            let body = r#"{"answers":{"tier":{"choice":"semi_big","confidence":0.91}}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    let config_path = std::env::temp_dir().join(format!(
        "route2-mcp-test-{}-{}.json",
        std::process::id(),
        port
    ));
    std::fs::write(
        &config_path,
        format!(
            r#"{{"policy_version":"mcp-test","backend":"decision","decision":{{"endpoint":"http://127.0.0.1:{port}/v1/systemone"}}}}"#
        ),
    )
    .expect("write test config");

    let exe = env!("CARGO_BIN_EXE_route2");
    let mut child = Command::new(exe)
        .arg("--mcp")
        .env("ROUTE2_CONFIG", &config_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("route2 --mcp child process starts");

    let mut stdin = child.stdin.take().expect("child stdin");
    let stdout = child.stdout.take().expect("child stdout");
    let mut reader = BufReader::new(stdout);

    // 1. Handshake: initialize
    let init_req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18"
        }
    });
    writeln!(stdin, "{}", serde_json::to_string(&init_req).unwrap()).unwrap();
    stdin.flush().unwrap();

    let mut line = String::new();
    reader
        .read_line(&mut line)
        .expect("read initialize response");
    let init_res: Value = serde_json::from_str(&line).expect("valid json response");
    assert_eq!(init_res["jsonrpc"], "2.0");
    assert_eq!(init_res["id"], 1);
    assert_eq!(init_res["result"]["serverInfo"]["name"], "route2");
    assert_eq!(init_res["result"]["protocolVersion"], "2025-06-18");

    // 2. Notification: initialized (server must NOT respond to notifications)
    let notify = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    writeln!(stdin, "{}", serde_json::to_string(&notify).unwrap()).unwrap();
    stdin.flush().unwrap();

    // 3. Discovery: tools/list
    let list_req = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    });
    writeln!(stdin, "{}", serde_json::to_string(&list_req).unwrap()).unwrap();
    stdin.flush().unwrap();

    line.clear();
    reader
        .read_line(&mut line)
        .expect("read tools/list response");
    let list_res: Value = serde_json::from_str(&line).expect("valid json response");
    assert_eq!(list_res["id"], 2);
    let tools = list_res["result"]["tools"].as_array().expect("tools array");
    let tool_names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(tool_names.contains(&"get_routing_tiers"));
    assert!(tool_names.contains(&"route"));
    assert!(tool_names.contains(&"classify"));

    // 4. Execution: tools/call get_routing_tiers
    let tiers_call = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "get_routing_tiers",
            "arguments": {
                "tier": "large"
            }
        }
    });
    writeln!(stdin, "{}", serde_json::to_string(&tiers_call).unwrap()).unwrap();
    stdin.flush().unwrap();

    line.clear();
    reader
        .read_line(&mut line)
        .expect("read get_routing_tiers call response");
    let tiers_res: Value = serde_json::from_str(&line).expect("valid json response");
    assert_eq!(tiers_res["id"], 3);
    let structured_tiers = &tiers_res["result"]["structuredContent"];
    assert_eq!(structured_tiers["tiers"].as_array().unwrap().len(), 1);
    assert_eq!(structured_tiers["tiers"][0]["name"], "large");
    assert_eq!(
        structured_tiers["tiers"][0]["recommended_model"],
        "gpt-6.1-sol"
    );
    assert_eq!(
        structured_tiers["tiers"][0]["recommended_reasoning_effort"],
        "high"
    );

    // 5. Execution: tools/call route with compact detail and timing
    let route_call = json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "tools/call",
        "params": {
            "name": "route",
            "arguments": {
                "task": "Refactor auth middleware to use JWT tokens",
                "report_decision_time_ms": true,
                "detail_level": "compact",
                "timeout_ms": 2000
            }
        }
    });
    writeln!(stdin, "{}", serde_json::to_string(&route_call).unwrap()).unwrap();
    stdin.flush().unwrap();

    line.clear();
    reader
        .read_line(&mut line)
        .expect("read route call response");
    let route_res: Value = serde_json::from_str(&line).expect("valid json response");
    assert_eq!(route_res["id"], 4);
    assert_eq!(route_res["result"]["isError"], false);
    let structured_route = &route_res["result"]["structuredContent"];
    assert!(structured_route.get("task_class").is_some());
    assert!(structured_route.get("recommended_model").is_some());
    assert!(structured_route.get("decision_time_ms").is_some());
    // In compact mode, verbose rationale and rule_ids are omitted
    assert!(structured_route.get("rationale").is_none());

    // 6. Error handling: unknown method (-32601)
    let unknown_method_req = json!({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "tools/unknown_method"
    });
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(&unknown_method_req).unwrap()
    )
    .unwrap();
    stdin.flush().unwrap();

    line.clear();
    reader
        .read_line(&mut line)
        .expect("read unknown method response");
    let err_res: Value = serde_json::from_str(&line).expect("valid json response");
    assert_eq!(err_res["id"], 5);
    assert_eq!(err_res["error"]["code"], -32601);

    // 7. Error handling: invalid arguments to tool (-32602)
    let invalid_arg_req = json!({
        "jsonrpc": "2.0",
        "id": 6,
        "method": "tools/call",
        "params": {
            "name": "route",
            "arguments": {
                "task": 12345
            }
        }
    });
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(&invalid_arg_req).unwrap()
    )
    .unwrap();
    stdin.flush().unwrap();

    line.clear();
    reader
        .read_line(&mut line)
        .expect("read invalid argument response");
    let arg_err_res: Value = serde_json::from_str(&line).expect("valid json response");
    assert_eq!(arg_err_res["id"], 6);
    assert_eq!(arg_err_res["error"]["code"], -32602);

    // 8. Clean exit
    let exit_req = json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "exit"
    });
    writeln!(stdin, "{}", serde_json::to_string(&exit_req).unwrap()).unwrap();
    stdin.flush().unwrap();
    drop(stdin);

    let status = child.wait().expect("child terminates cleanly");
    assert!(status.success());
    mock.join().expect("mock classifier server");
    let _ = std::fs::remove_file(config_path);
}
