use route2::{validate_policy, Router};

#[test]
fn test_validate_builtin_policy() {
    let router = Router::default();
    assert!(validate_policy(router.policy()).is_ok());
}

#[test]
fn test_validate_rejects_non_decision_backend() {
    let err = Router::from_json(r#"{"policy_version":"test","backend":"unsupported"}"#)
        .expect_err("unsupported backend must fail");
    assert!(err.to_string().contains("backend must be 'decision'"));
}
