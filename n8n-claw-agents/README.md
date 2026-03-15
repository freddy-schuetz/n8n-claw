# n8n-claw Expert Agents

Expert agent personas for [n8n-claw](https://github.com/freddy-schuetz/n8n-claw) — the self-hosted AI agent system. Install specialized sub-agents with a single chat command.

---

## Available Agents

| Agent | Category | Description | Based on |
|-------|----------|-------------|----------|
| [research-expert](agents/research-expert/) | General | Web research, fact-checking, source evaluation | — |
| [content-creator](agents/content-creator/) | General | Text creation, social media, blog articles, marketing copy | — |
| [data-analyst](agents/data-analyst/) | General | Data analysis, pattern recognition, structured reports | — |
| [code-reviewer](agents/code-reviewer/) | Development | Constructive code reviews: correctness, security, maintainability | [agency-agents](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-code-reviewer.md) |
| [seo-specialist](agents/seo-specialist/) | Marketing | Technical SEO, content optimization, link authority, organic growth | [agency-agents](https://github.com/msitarzewski/agency-agents/blob/main/marketing/marketing-seo-specialist.md) |

---

## How It Works

Expert agents are specialized sub-agents that your main n8n-claw agent can delegate tasks to. Each agent has its own **expertise profile** (persona) that defines what it knows, how it works, and what quality standards it follows.

The main agent's personality stays unchanged — it delegates specific tasks to experts and rephrases their results in its own tone. The user never talks to a sub-agent directly.

**Architecture:**

```
User → Main Agent → Expert Agent Tool → Sub-Agent Runner
                                            ├── Loads persona from DB
                                            ├── Builds system prompt
                                            └── Runs AI Agent (Claude + HTTP/WebSearch/MCP)
                                                → Returns result to Main Agent
                                                    → Main Agent rephrases in own tone → User
```

---

## Usage

Agents are managed via chat with your n8n-claw agent:

```
"What expert agents do you have?"      → lists installed agents
"Show me available expert agents"      → lists all agents from catalog
"Install the Research Expert"          → installs from catalog
"Remove the Data Analyst"             → uninstalls
```

Delegation happens automatically when the main agent decides a task fits an expert:

```
"Research the best hiking trails in Tyrol"    → delegates to research-expert
"Write an Instagram post about our product"   → delegates to content-creator
"Analyze these sales numbers"                 → delegates to data-analyst
```

The default agents (research-expert, content-creator, data-analyst) ship pre-installed with `setup.sh`.

---

## Agent Structure

Each agent lives in its own directory under `agents/`:

```
agents/
  index.json                    ← catalog (one entry per agent)
  {agent-id}/
    manifest.json               ← metadata (name, category, description, attribution)
    persona.json                ← persona content (system prompt for the sub-agent)
```

### manifest.json

```json
{
  "id": "my-agent",
  "name": "My Agent",
  "version": "1.0.0",
  "category": "general",
  "description": "What this agent does",
  "emoji": "🎯",
  "author": "your-github-username",
  "license": "MIT"
}
```

#### Manifest fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique agent ID (lowercase, hyphens only) |
| `name` | yes | Display name |
| `version` | yes | Semver version (e.g. `1.0.0`) |
| `category` | yes | Category for filtering (see below) |
| `description` | yes | Short description |
| `emoji` | yes | Single emoji representing the agent |
| `author` | yes | GitHub username |
| `license` | yes | License identifier (e.g. `MIT`) |
| `based_on` | no | Attribution object (see [Attribution](#attribution)) |

**Categories:** `general`, `marketing`, `development`, `analytics`, `creative`

### persona.json

```json
{
  "format": "n8n-claw-agent",
  "format_version": 1,
  "persona_key": "persona:my-agent",
  "display_name": "My Agent",
  "content": "# My Agent\n\n## Expertise\n...\n\n## Workflow\n...\n\n## Quality Standards\n..."
}
```

#### Persona fields

| Field | Required | Description |
|-------|----------|-------------|
| `format` | yes | Must be `n8n-claw-agent` |
| `format_version` | yes | Must be `1` |
| `persona_key` | yes | DB key: `persona:{agent-id}` |
| `display_name` | yes | Human-readable name |
| `content` | yes | Persona content (Markdown, escaped as JSON string) |

### index.json

The central catalog. Add one entry per agent:

```json
{
  "id": "my-agent",
  "name": "My Agent",
  "version": "1.0.0",
  "category": "general",
  "description": "What this agent does",
  "emoji": "🎯",
  "author": "your-github-username"
}
```

---

## Persona Content Guidelines

Expert agents are **pure expertise profiles** — they are tools, not personalities.

**DO:**
- Define clear expertise areas (`## Expertise`)
- Describe a structured workflow (`## Workflow`)
- Set quality standards (`## Quality Standards`)
- Write in English
- Reference available tools where appropriate (HTTP, Web Search, MCP)

**DON'T:**
- Give the agent a name or personality traits
- Add greetings or conversation starters
- Use first person ("I am...")
- Include tool configuration (tools are injected by the Sub-Agent Runner)

### Available Sub-Agent Tools

The Sub-Agent Runner provides these tools to every expert agent automatically:

| Tool | Description |
|------|-------------|
| **HTTP Request** | Call any URL (GET, POST, PUT, DELETE) |
| **Web Search** | DuckDuckGo instant answers and related topics |
| **MCP Client** | Call tools on installed MCP skill servers |

You don't need to configure these — just reference them in the persona's Workflow section where appropriate (e.g. "Recherchiere via Web Search").

### Example Persona

```markdown
# Research Expert

## Expertise
Web research, fact-checking, source evaluation, summarizing complex topics.

## Workflow
1. Analyze the topic and research question
2. Research multiple independent sources (Web Search + HTTP)
3. Cross-check facts and identify contradictions
4. Deliver structured results with source citations

## Quality Standards
- Always cite sources (URLs, titles)
- Transparently flag uncertainties and knowledge gaps
- Never present speculation as fact
- When sources contradict: present both sides
- Check and note the timeliness of information
```

---

## Attribution

Some agent personas may be inspired by or adapted from [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) (MIT License, 31k+ Stars).

When an agent is based on a prompt from that repo:

1. Add the `based_on` field to `manifest.json`:
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

2. The "Based on" column in the [Available Agents](#available-agents) table links to the original source
3. Note the attribution in your PR description

The original agency-agents format (`# Identity`, `# System Prompt`, `# Output Format`) must be adapted to our expertise-profile format (`## Expertise`, `## Workflow`, `## Quality Standards`).

---

## Contributing

### Step-by-step

1. Fork this repository
2. Create a directory under `agents/` with your agent ID (lowercase, hyphens only)
3. Add `manifest.json` with all required fields
4. Add `persona.json` with the expertise profile
5. Add an entry to `agents/index.json`
6. Update the [Available Agents](#available-agents) table in this README (sorted: Category, then Agent alphabetically)
7. Submit a pull request

For a detailed guide with annotated examples, see [TEMPLATE_EXAMPLE.md](TEMPLATE_EXAMPLE.md).

### PR checklist

- [ ] Agent ID is lowercase with hyphens only (e.g. `seo-specialist`)
- [ ] `manifest.json` has all required fields
- [ ] `persona.json` uses format `n8n-claw-agent` with format_version `1`
- [ ] `persona_key` matches `persona:{agent-id}`
- [ ] Persona follows expertise-profile format (no personality, no greetings)
- [ ] `index.json` entry matches manifest data
- [ ] README table updated with new agent
- [ ] If based on agency-agents: `based_on` field in manifest + noted in PR
- [ ] All persona content in English

---

## CDN

Agents are served via jsDelivr CDN for fast, reliable delivery:

```
https://cdn.jsdelivr.net/gh/freddy-schuetz/n8n-claw-agents@master/agents/index.json
https://cdn.jsdelivr.net/gh/freddy-schuetz/n8n-claw-agents@master/agents/{id}/manifest.json
https://cdn.jsdelivr.net/gh/freddy-schuetz/n8n-claw-agents@master/agents/{id}/persona.json
```

The CDN uses the `@master` branch reference. In production, pin to a specific commit hash to avoid caching issues. Purge cache if needed:

```bash
curl https://purge.jsdelivr.net/gh/freddy-schuetz/n8n-claw-agents@<hash>/agents/index.json
```

For a reference of agent file formats, see [TEMPLATE_EXAMPLE.md](TEMPLATE_EXAMPLE.md).

---

## License

MIT
