# Creating a New Expert Agent

This guide explains how to add a new expert agent to the n8n-claw-agents catalog.

## Directory Structure

Each agent needs its own directory under `agents/`:

```
agents/
├── index.json                  # Add your agent here
└── your-agent-id/
    ├── manifest.json           # Metadata
    └── persona.json            # Persona content (system prompt)
```

## 1. manifest.json

```json
{
  "id": "your-agent-id",
  "name": "Your Agent Name",
  "version": "1.0.0",
  "category": "general",
  "description": "Short description of what this agent does",
  "emoji": "🎯",
  "author": "your-github-username",
  "license": "MIT"
}
```

**Categories:** `general`, `marketing`, `development`, `analytics`, `creative`

**If based on [agency-agents](https://github.com/msitarzewski/agency-agents)**, add attribution:
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

## 2. persona.json

```json
{
  "format": "n8n-claw-agent",
  "format_version": 1,
  "persona_key": "persona:your-agent-id",
  "display_name": "Your Agent Name",
  "content": "# Your Agent Name\n\n## Expertise\n...\n\n## Workflow\n...\n\n## Quality Standards\n..."
}
```

### Persona Content Guidelines

Expert agents are **pure expertise profiles** — they are tools, not personalities.

**DO:**
- Define clear expertise areas
- Describe a structured workflow (`## Workflow`)
- Set quality standards (`## Quality Standards`)
- Focus on what the agent does and how

**DON'T:**
- Give the agent a name or character
- Add personality traits or greetings
- Include conversation starters
- Use first person ("I am...")

The user never talks to a sub-agent directly. The main agent delegates tasks and rephrases the result in its own tone.

### Available Tools

Sub-agents have access to:
- **HTTP Request** — call any URL
- **Web Search** — DuckDuckGo search
- **MCP Client** — call tools on installed MCP servers

Reference these in the Workflow section where appropriate.

## 3. Update index.json

Add your agent to `agents/index.json`:

```json
{
  "id": "your-agent-id",
  "name": "Your Agent Name",
  "version": "1.0.0",
  "category": "general",
  "description": "Short description",
  "emoji": "🎯",
  "author": "your-github-username"
}
```

## 4. Submit

1. Fork this repo
2. Create your agent directory with manifest.json + persona.json
3. Add entry to index.json
4. Submit a pull request
