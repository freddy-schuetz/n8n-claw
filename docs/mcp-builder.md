# MCP Builder — How it works

## Architecture

When you ask Greg to build a new MCP tool, the MCP Builder workflow runs:

```
Start → Search API Docs (Brave) → Fetch Docs (Jina Reader)
     → BuildPrompt (LLM prompt with docs)
     → Generate Tool (Claude)
     → Assemble & Deploy
     → Create Sub-Workflow (Code node with actual logic)
     → Activate Sub-Workflow
     → Build MCP JSON
     → Create MCP Workflow (mcpTrigger + toolWorkflow)
     → Test MCP (actual MCP protocol call)
     → Register in Supabase mcp_registry
     → Update agent mcp_instructions
```

## Key Design Decisions

### toolWorkflow instead of toolCode

n8n's `toolCode` node requires `specifyInputSchema: true` for the `query` variable to work. However, **this field is silently ignored when creating workflows via API** (known n8n bug). 

Solution: Use `toolWorkflow` pattern instead:
- MCP Trigger → toolWorkflow → Sub-Workflow
- Sub-Workflow receives parameters via `$json.param_name` (always works)

### Two-workflow pattern

Each MCP server consists of **two workflows**:

1. **MCP Server workflow** — `mcpTrigger` + `toolWorkflow` node pointing to sub-workflow
2. **Sub-Workflow** — `Execute Workflow Trigger` + `Code` node with actual API logic

The sub-workflow receives parameters via `$json` which works reliably via API.

### Automatic testing

After deployment, the builder makes a real MCP protocol call:
1. `initialize` → get session ID
2. `notifications/initialized`  
3. `tools/call` with sample args

If the test fails, it attempts an auto-fix via LLM.

## Webhook Bug

After creating a workflow via API, the MCP webhook is not immediately registered. **You must manually deactivate and reactivate the MCP workflow in the n8n UI** for it to start accepting connections.

This is a known n8n issue. The builder includes a reminder in its response.

## Adding to registry

After successful build, the server is automatically:
1. Added to `mcp_registry` table in Supabase
2. Agent's `mcp_instructions` updated with new server info
