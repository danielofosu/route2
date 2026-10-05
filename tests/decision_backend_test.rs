use route2::{Router, ROUTING_DECISION_INSTRUCTIONS, ROUTING_TIER_CRITERIA};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

fn route_answer(answer: &str) -> route2::RouteDecision {
    route_answer_with_state(answer, "Fix the parser").0
}

fn route_answer_with_state(answer: &str, state: &str) -> (route2::RouteDecision, Value) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let answer = answer.to_string();
    let (request_sender, request_receiver) = mpsc::channel();
    let server = std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut request = [0; 8192];
            let size = stream.read(&mut request).unwrap_or(0);
            if size == 0 {
                continue;
            }
            let bytes = &request[..size];
            let body = bytes
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|offset| &bytes[offset + 4..])
                .expect("HTTP request body");
            request_sender
                .send(serde_json::from_slice::<Value>(body).expect("JSON request"))
                .unwrap();
            let body = format!(r#"{{"answers":{{"tier":{answer}}}}}"#);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            break;
        }
    });
    let router = Router::from_json(&format!(r#"{{"policy_version":"decision-test","backend":"decision","decision":{{"endpoint":"http://127.0.0.1:{port}/v1/systemone","model":"pinned-decision"}}}}"#)).unwrap();
    let result = router.route(state);
    server.join().unwrap();
    (result, request_receiver.recv().unwrap())
}

#[test]
fn decision_backend_emits_model_provenance_and_effort() {
    let result = route_answer(r#"{"choice":"semi_big","confidence":0.91}"#);
    assert_eq!(result.task_class, "semi_big");
    assert_eq!(result.rule_ids, ["decision.pinned-decision"]);
    assert_eq!(result.target_model, "gpt-6.1-sol");
    assert_eq!(result.recommended_reasoning_effort, "medium");
    assert!(result.rationale.contains("uncalibrated confidence"));
}

#[test]
fn obsolete_backend_is_rejected_instead_of_starting_a_legacy_model() {
    let result = Router::from_json(r#"{"policy_version":"obsolete","backend":"kev"}"#);
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("backend must be 'decision'"));
}

#[test]
fn decision_request_uses_next_step_difficulty_criteria() {
    let state = r#"{"objective":"repair the queue worker","currentphase":"debugging","unresolved":"two hypotheses failed","outcomes":["test failed"],"currenteffort":"medium","requestssincedecision":2}"#;
    let (result, request) =
        route_answer_with_state(r#"{"choice":"large","confidence":0.63}"#, state);
    assert_eq!(result.task_class, "large");
    assert_eq!(request["state"], state);
    assert_eq!(
        request["questions"]["tier"]["instructions"],
        ROUTING_DECISION_INSTRUCTIONS
    );
    let expected = ROUTING_TIER_CRITERIA
        .iter()
        .map(|(tier, criteria)| ((*tier).to_string(), Value::String((*criteria).to_string())))
        .collect::<serde_json::Map<_, _>>();
    assert_eq!(
        request["questions"]["tier"]["criteria"],
        Value::Object(expected)
    );
    assert!(request["questions"]["tier"]["criteria"]["small"]
        .as_str()
        .unwrap()
        .contains("Low reasoning difficulty"));
    assert!(request["questions"]["tier"]["criteria"]["semi_big"]
        .as_str()
        .unwrap()
        .contains("Medium reasoning difficulty"));
    assert!(request["questions"]["tier"]["criteria"]["large"]
        .as_str()
        .unwrap()
        .contains("High reasoning difficulty"));
    assert!(request["questions"]["tier"]["criteria"]["safety_sensitive"]
        .as_str()
        .unwrap()
        .contains("Topic alone is insufficient"));
}

#[test]
fn malformed_decisions_do_not_produce_recommendations() {
    for answer in [
        r#"{"choice":"unknown","confidence":0.9}"#,
        r#"{"choice":"small"}"#,
        r#"{"choice":"small","confidence":1.1}"#,
    ] {
        let result = route_answer(answer);
        assert_eq!(result.task_class, "error");
        assert!(result.recommended_model.is_empty());
        assert_eq!(result.window_generations, 0);
    }
}

#[test]
fn decision_requires_explicit_configuration() {
    assert!(Router::from_json(r#"{"policy_version":"test","backend":"decision"}"#).is_err());
    assert!(Router::from_json(r#"{"policy_version":"test","backend":"DECISION"}"#).is_err());
}
