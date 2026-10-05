# Benchmark results

All benchmarks compare GPT-6.1 Sol with one completion per task, scored with
the official EvalPlus 0.3.1 full base and expanded tests on Linux. Prompts,
fixtures and quality guardrails were fixed before scoring. These are observed
results from a single completion per task, not a general equivalence or
savings guarantee.

## HumanEval+ comparison (164 tasks)

How it was run: fixed-high `gpt-6.1-sol` without Route2 versus the same model
routed through the Route2 provider proxy, each task once. The fixed-high run
is reused unchanged from a previous run; only the Route2 arm generated new
answers.

| Run | Full base + expanded passes | Estimated generation cost | Mean end-to-end time |
| --- | ---: | ---: | ---: |
| Fixed high, without Route2 | 156/164 (95.1%) | $0.249572 | 5.97 s |
| Route2 | 157/164 (95.7%) | $0.211472 | 8.39 s |

In this run Route2 used about 15.3% less estimated generation cost and took
about 40.5% longer, including local classification. It passed every task the
baseline passed, plus one more. Route2 selected medium on 151 tasks and low
on 13, with no classifier fallbacks. The first classifier request took
24.10 s (managed runtime startup); subsequent requests averaged about 1.17 s.

## Pre-change comparison

All 164 HumanEval+ problems generated once per arm with fixed high versus the
Decision 2.0 provider proxy. Both arms passed 156/164 (95.1%) on full base and
expanded tests.

## SWE-bench Verified pilot

One paired task (`pallets__flask-5014`), official swebench harness: baseline
high resolved the task, Route2 medium also resolved it. Not a full benchmark
score.

## Repository tool checks

Three custom Node fixture tasks (records-jsonl-stats, ttl-memo-cache,
config-deep-merge). All passed their final independent tests after four model
requests each; routine continuations held effort, one task escalated to high
and one dropped to low on reassessment. Custom inspectable checks, not
official benchmark scores.
