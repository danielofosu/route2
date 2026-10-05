# Contributing

Route2 is a macOS (Apple Silicon) + Codex product. Development requires:

- Rust stable toolchain (`cargo fmt`, `clippy`, `test`)
- Python 3.11+ (`python3 -m unittest discover -s tests -p 'test_*.py'`)
- Node 24 (`node --test tests/*_test.mjs`)

Run the full local gate before opening a PR:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*_test.mjs
```

Tests use loopback model/upstream fixtures only and make no paid provider
calls. A live classifier requires the setup-downloaded Decision 2.0 weights.
Keep the scope macOS + Codex; do not add Windows/Linux product paths.

Benchmarks: see `docs/benchmarks/results.md`. Benchmark inputs are frozen;
do not rewrite historical results, only add new, clearly separated runs.
