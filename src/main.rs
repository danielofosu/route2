use route2::{event_logger_from_env, mcp, CompactRouteDecision, EventLogger, RouteOptions, Router};
use std::io::{self, Read};
use std::path::PathBuf;

#[derive(Debug, Default)]
struct CliOptions {
    mcp: bool,
    pretty: bool,
    info: bool,
    tiers: bool,
    validate: bool,
    include_task: bool,
    report_time: bool,
    model_only: bool,
    detail: Option<String>,
    timeout_ms: Option<u64>,
    config: Option<PathBuf>,
    event_log: Option<PathBuf>,
    task_parts: Vec<String>,
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.first().is_some_and(|arg| arg == "install-codex") {
        install_codex(&arguments[1..]);
        return;
    }
    if arguments.first().is_some_and(|arg| arg == "diagnostics") {
        let mut diagnostic_arguments = vec!["--diagnostics".to_string()];
        diagnostic_arguments.extend_from_slice(&arguments[1..]);
        install_codex(&diagnostic_arguments);
        return;
    }
    if arguments.first().is_some_and(|arg| arg == "menu-bar") {
        run_python_helper("macos_menu_bar.py", &arguments[1..], false);
        return;
    }
    if arguments
        .iter()
        .any(|argument| argument == "--help" || argument == "-h")
    {
        print_help();
        return;
    }
    if arguments
        .iter()
        .any(|argument| argument == "--version" || argument == "-V")
    {
        println!("route2 {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let options = match parse_args(&arguments) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("route2: {error}");
            std::process::exit(2);
        }
    };

    let config = options
        .config
        .clone()
        .or_else(|| std::env::var_os("ROUTE2_CONFIG").map(PathBuf::from));
    let router = match Router::load(config.as_deref()) {
        Ok(router) => router,
        Err(error) => {
            eprintln!("route2: {error}");
            std::process::exit(2);
        }
    };

    if options.info {
        handle_info(&router);
        return;
    }

    if options.validate {
        handle_validate(&router);
        return;
    }

    if options.tiers {
        handle_tiers(&router, options.pretty);
        return;
    }

    let mut logger = event_logger_from_env();
    if let Some(path) = options.event_log {
        logger = EventLogger::new(Some(path), options.include_task);
    } else if options.include_task {
        logger = EventLogger::new(logger.path().map(PathBuf::from), true);
    }

    if options.mcp {
        if let Err(error) = mcp::run_stdio(&router, &logger) {
            eprintln!("route2 MCP server error: {error}");
            std::process::exit(1);
        }
        return;
    }

    let task = if options.task_parts.is_empty() {
        read_stdin_task()
    } else {
        options.task_parts.join(" ")
    };
    let route_options = RouteOptions {
        timeout_ms: options.timeout_ms,
        report_decision_time_ms: options.report_time,
        detail_level: options.detail.clone(),
    };
    let decision = router.route_with_options(&task, &route_options);
    if let Err(error) = logger.record("cli", &task, &decision) {
        eprintln!("route2: event log write failed: {error}");
    }

    if options.model_only {
        println!("{}", decision.recommended_model);
        return;
    }

    let is_compact = options.detail.as_deref() == Some("compact");
    if is_compact {
        let compact = CompactRouteDecision::from(&decision);
        if options.pretty {
            println!(
                "{}",
                serde_json::to_string_pretty(&compact).expect("compact decision is serializable")
            );
        } else {
            println!(
                "{}",
                serde_json::to_string(&compact).expect("compact decision is serializable")
            );
        }
    } else if options.pretty {
        println!(
            "{}",
            serde_json::to_string_pretty(&decision).expect("route decision is serializable")
        );
    } else {
        println!(
            "{}",
            serde_json::to_string(&decision).expect("route decision is serializable")
        );
    }
}

fn install_codex(arguments: &[String]) {
    run_python_helper("install_codex.py", arguments, true);
}

fn run_python_helper(script_name: &str, arguments: &[String], include_router: bool) {
    let root = route2::source_root();
    let script = root.join("scripts").join(script_name);
    if !script.is_file() {
        eprintln!("route2: setup helper not found; set ROUTE2_SOURCE_DIR to the source checkout");
        std::process::exit(2);
    }
    let mut command = std::process::Command::new("uv");
    command.args(["run", "--no-project", "--python", "3.12", "python"]);
    command.arg(script);
    if include_router
        && !arguments
            .iter()
            .any(|arg| arg == "--router" || arg.starts_with("--router="))
    {
        if let Ok(executable) = std::env::current_exe() {
            command.arg("--router").arg(executable);
        }
    }
    command.args(arguments);
    match command.status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("route2: cannot start the Codex installer with uv: {error}");
            std::process::exit(2);
        }
    }
}

fn parse_args(arguments: &[String]) -> Result<CliOptions, String> {
    let mut options = CliOptions::default();
    let mut index = 0;
    let mut end_options = false;
    while index < arguments.len() {
        let argument = &arguments[index];
        if end_options {
            options.task_parts.push(argument.clone());
            index += 1;
            continue;
        }
        match argument.as_str() {
            "--" => {
                end_options = true;
                index += 1;
            }
            "--mcp" | "mcp" => {
                options.mcp = true;
                index += 1;
            }
            "--pretty" => {
                options.pretty = true;
                index += 1;
            }
            "info" => {
                options.info = true;
                index += 1;
            }
            "validate" | "check" => {
                options.validate = true;
                index += 1;
            }
            "setup" => {
                return Err("setup was removed; use route2 install-codex --install".to_string());
            }
            "tiers" | "get-tiers" => {
                options.tiers = true;
                index += 1;
            }
            "--report-time" | "--timing" => {
                options.report_time = true;
                index += 1;
            }
            "--model-only" | "--target-model" => {
                options.model_only = true;
                index += 1;
            }
            "--detail" => {
                let value = arguments
                    .get(index + 1)
                    .ok_or_else(|| "--detail requires a value (full or compact)".to_string())?;
                if value != "full" && value != "compact" {
                    return Err(format!(
                        "invalid --detail '{value}'; expected 'full' or 'compact'"
                    ));
                }
                options.detail = Some(value.clone());
                index += 2;
            }
            "--timeout" => {
                let value = arguments
                    .get(index + 1)
                    .ok_or_else(|| "--timeout requires milliseconds integer".to_string())?;
                let ms = value
                    .parse::<u64>()
                    .map_err(|_| format!("invalid --timeout '{value}'; expected integer ms"))?;
                options.timeout_ms = Some(ms);
                index += 2;
            }
            "--json" | "route" | "classify" => {
                // JSON is the default output.  `route` and `classify` make the
                // command self-documenting while retaining argument-free stdin mode.
                index += 1;
            }
            "--include-task" => {
                options.include_task = true;
                index += 1;
            }
            "--config" | "--event-log" => {
                let value = arguments
                    .get(index + 1)
                    .ok_or_else(|| format!("{argument} requires a path"))?;
                if value.starts_with('-') {
                    return Err(format!("{argument} requires a path"));
                }
                if argument == "--config" {
                    options.config = Some(PathBuf::from(value));
                } else {
                    options.event_log = Some(PathBuf::from(value));
                }
                index += 2;
            }
            value if value.starts_with("--config=") => {
                let path = value.trim_start_matches("--config=");
                if path.is_empty() {
                    return Err("--config requires a path".to_string());
                }
                options.config = Some(PathBuf::from(path));
                index += 1;
            }
            value if value.starts_with("--event-log=") => {
                let path = value.trim_start_matches("--event-log=");
                if path.is_empty() {
                    return Err("--event-log requires a path".to_string());
                }
                options.event_log = Some(PathBuf::from(path));
                index += 1;
            }
            value if value.starts_with('-') => {
                return Err(format!("unknown option: {value}"));
            }
            _ => {
                options.task_parts.push(argument.clone());
                index += 1;
            }
        }
    }
    Ok(options)
}

fn read_stdin_task() -> String {
    let mut input = String::new();
    if let Err(error) = io::stdin().read_to_string(&mut input) {
        eprintln!("route2: unable to read stdin: {error}");
    }
    input
}

fn print_help() {
    println!("Automatic Codex setup: route2 install-codex --install\nPreview setup: route2 install-codex\nRemove setup: route2 install-codex --uninstall\nLocal routing logs and timing: route2 diagnostics [--session SESSION_ID]\nmacOS menu-bar companion: route2 menu-bar [--uninstall]\n");
    println!(
        "route2 {}\n\nUsage:\n  route2 [OPTIONS] [TASK ...]\n  route2 route [OPTIONS] [TASK ...]\n  route2 tiers [--pretty]\n  route2 validate [--config PATH]\n  route2 info\n  echo 'TASK' | route2 [OPTIONS]\n  route2 --mcp [--config PATH] [--event-log PATH]\n\nCommands:\n  route               Route a task (default)\n  tiers               Inspect routing tier definitions and recommended models\n  validate            Validate the routing policy configuration\n  info                Display active backend and Codex integration guidance\n\nOptions:\n  --detail LEVEL      Output detail mode ('full' or 'compact')\n  --report-time       Measure and report routing decision time in milliseconds\n  --timeout MS        Override backend inference timeout in milliseconds\n  --config PATH       Load custom JSON policy override (auto-detects .route2/config.json)\n  --event-log PATH    Append route_decision JSONL events to PATH\n  --include-task      Include task text in an explicitly configured event log\n  --pretty            Pretty-print the route JSON\n  --json              Explicitly select the default JSON output\n  --mcp               Internal stdio MCP transport for the classifier/provider\n  -h, --help          Show this help\n  -V, --version       Show the version\n\nEnvironment:\n  ROUTE2_CONFIG       Policy path used when --config is omitted\n  ROUTE2_EVENT_LOG    Event JSONL path used when --event-log is omitted\n  ROUTE2_EVENT_INCLUDE_TASK=1 enables task text for that environment log\n",
        env!("CARGO_PKG_VERSION")
    );
}

fn handle_validate(router: &Router) {
    if let Err(e) = route2::validate_policy(router.policy()) {
        eprintln!("✗ Validation failed: {e}");
        std::process::exit(1);
    }
    let config_display = router
        .config_source()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "Built-in policy (embedded)".to_string());
    println!("✓ route2 policy '{}' is valid", router.policy_version());
    println!("  - Config:       {config_display}");
    println!("  - Backend:      {}", router.backend_name());
}

fn handle_tiers(router: &Router, pretty: bool) {
    let catalog = router.get_routing_tiers(None);
    if pretty {
        println!(
            "{}",
            serde_json::to_string_pretty(&catalog).expect("tiers catalog is serializable")
        );
    } else {
        println!(
            "route2 Routing Tiers (Backend: {}, Policy: {})",
            catalog.active_backend, catalog.policy_version
        );
        println!("{:-<75}", "");
        println!(
            "{:<18} {:<20} {:<12} CRITERIA",
            "TIER", "RECOMMENDED MODEL", "REASONING"
        );
        println!("{:-<75}", "");
        for tier in &catalog.tiers {
            println!(
                "{:<18} {:<20} {:<12} {}",
                tier.name, tier.recommended_model, tier.recommended_reasoning_effort, tier.criteria
            );
        }
        println!("{:-<75}", "");
    }
}

fn handle_info(router: &Router) {
    let backend = router.backend_name();
    println!("route2 v{}", env!("CARGO_PKG_VERSION"));
    println!("Policy version: {}", router.policy_version());
    println!("Active backend: {}", backend);
    let config_display = router
        .config_source()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "Built-in policy (embedded)".to_string());
    println!("Configuration:  {}", config_display);
    println!();
    println!("Codex integration: run `route2 install-codex --install` for automatic routing.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_accepts_subcommand_and_options() {
        let options = parse_args(&[
            "route".to_string(),
            "--pretty".to_string(),
            "--config".to_string(),
            "policy.json".to_string(),
            "summarize".to_string(),
            "this".to_string(),
        ])
        .expect("arguments parse");
        assert!(options.pretty);
        assert_eq!(options.config, Some(PathBuf::from("policy.json")));
        assert_eq!(options.task_parts, vec!["summarize", "this"]);
    }

    #[test]
    fn parser_rejects_unknown_option() {
        let error = parse_args(&["--nope".to_string()]).expect_err("unknown option should fail");
        assert!(error.contains("unknown option"));
    }

    #[test]
    fn parser_accepts_timing_and_detail_options() {
        let options = parse_args(&[
            "route".to_string(),
            "--report-time".to_string(),
            "--detail".to_string(),
            "compact".to_string(),
            "--timeout".to_string(),
            "1500".to_string(),
            "test task".to_string(),
        ])
        .expect("options parse");
        assert!(options.report_time);
        assert_eq!(options.detail, Some("compact".to_string()));
        assert_eq!(options.timeout_ms, Some(1500));
    }

    #[test]
    fn parser_accepts_tiers_subcommand() {
        let options =
            parse_args(&["tiers".to_string(), "--pretty".to_string()]).expect("tiers parses");
        assert!(options.tiers);
        assert!(options.pretty);
    }
}
