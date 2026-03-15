# CLAUDE.md — n8n-claw Expert Agents

This repo contains expert agent personas for [n8n-claw](https://github.com/freddy-schuetz/n8n-claw).

---

## What Are Expert Agents?

Expert agents are specialized sub-agents that the main n8n-claw agent delegates tasks to. Each agent has a **persona** — a pure expertise profile defining what it knows, how it works, and what quality standards it follows.

Sub-agents are tools, not characters. The user never talks to them directly. The main agent delegates, receives the result, and rephrases it in its own tone.

---

## Repo Structure

```
n8n-claw-agents/
├── agents/
│   ├── index.json                  # Central catalog (lists all available agents)
│   └── <agent-id>/
│       ├── manifest.json           # Metadata (name, category, description, attribution)
│       └── persona.json            # Persona content (system prompt for the sub-agent)
├── TEMPLATE_EXAMPLE.md             # Step-by-step guide for creating new agents
├── README.md                       # Overview and available agents table
└── CLAUDE.md                       # This file
```

---

## How Agents Are Used

1. **Agent Library Manager** (in n8n-claw) fetches `index.json` from this repo via CDN
2. User says "Install Research Expert" → Library Manager fetches `agents/research-expert/persona.json`
3. Persona content is stored in PostgreSQL (`agents` table, key `persona:research-expert`)
4. When the main agent delegates a task, the **Sub-Agent Runner** loads the persona from DB, builds a system prompt, and runs an independent AI Agent node

---

## Creating a New Agent

See [TEMPLATE_EXAMPLE.md](TEMPLATE_EXAMPLE.md) for the full guide. Quick checklist:

### 1. Create directory: `agents/<your-agent-id>/`

### 2. Write `manifest.json`:
```json
{
  "id": "your-agent-id",
  "name": "Your Agent Name",
  "version": "1.0.0",
  "category": "general",
  "description": "What this agent does",
  "emoji": "🎯",
  "author": "your-github-username",
  "license": "MIT"
}
```

If the persona is based on or inspired by [agency-agents](https://github.com/msitarzewski/agency-agents), add attribution:
```json
{
  "based_on": {
    "source": "agency-agents",
    "url": "https://github.com/msitarzewski/agency-agents",
    "original_prompt": "prompts/category/agent-name.md",
    "license": "MIT"
  }
}
```

### 3. Write `persona.json`:
```json
{
  "format": "n8n-claw-agent",
  "format_version": 1,
  "persona_key": "persona:your-agent-id",
  "display_name": "Your Agent Name",
  "content": "# Your Agent Name\n\n## Expertise\n...\n\n## Workflow\n...\n\n## Quality Standards\n..."
}
```

### 4. Add to `agents/index.json`

### 5. Submit PR

---

## Persona Content Guidelines

**DO:**
- Define clear expertise areas (`## Expertise`)
- Describe a structured workflow (`## Workflow`)
- Set quality standards (`## Quality Standards`)
- Write in English

**DON'T:**
- Give the agent a name or personality traits
- Add greetings or conversation starters
- Use first person ("I am...")
- Include tool-specific instructions (tools are injected by the runner)

---

## Available Sub-Agent Tools

The Sub-Agent Runner provides these tools to every expert agent:
- **HTTP Request** — call any URL (GET, POST, etc.)
- **Web Search** — DuckDuckGo instant answers
- **MCP Client** — call tools on installed MCP skill servers

You don't need to configure these — just reference them in the persona's Workflow section where appropriate.

---

## Attribution

Some agent personas may be inspired by or adapted from [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) (MIT License). When adapting a prompt from that repo:

1. Add the `based_on` field to `manifest.json` (see above)
2. Note it in the PR description
3. The original prompt format is different (agency-agents uses `# Identity`, `# System Prompt`, etc.) — adapt to our expertise-profile format

---

## CDN

This repo is served via jsDelivr CDN. After pushing changes:
- URL pattern: `https://cdn.jsdelivr.net/gh/freddy-schuetz/n8n-claw-agents@<commit>/agents/...`
- Pin to specific commit hashes in production (jsDelivr caches `@master` for hours)
- Purge cache if needed: `curl https://purge.jsdelivr.net/gh/freddy-schuetz/n8n-claw-agents@<hash>/agents/index.json`
