# Performance Test MCP

Local orchestration helper for iOS performance experiments. It reads the current scenario YAML files, prepares structured test plans, and finalizes evidence and reports after Claude coordinates `mobile-mcp` and `instruments-mcp-server`.

This is intentionally a personal-use tool, not a test-management platform.

## Current status

Design approved; implementation plan pending.

## Related components

- `../instruments-mcp-server/` — Instruments collection and parsers
- `mobile-mcp` — device/UI automation supplied by the environment
