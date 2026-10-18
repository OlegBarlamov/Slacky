# slacky CLI

Slacky from the command line, for people and AI agents. Design notes: [docs/CLI.md](../docs/CLI.md).

## Quick start: an AI agent organizing the CEO event

```bash
npm install            # once
npm run dev:server     # terminal 1: the Slacky server
npm run agent          # terminal 2: Claude Code, signed in to Slacky as "event-bot"
```

That's all. `npm run agent` gives only this session permission to run `slacky` and the
[organize-ceo-event](skills/organize-ceo-event/SKILL.md) skill as its instructions. Other Claude
Code sessions in the repo aren't affected. The agent registers itself on first use.
Open http://localhost:5173 (`npm run dev`) to talk to it as a person.

- **Another name:** `SLACKY_USER=planner-bot npm run agent`.
- **Keep it working while you're away:** in the agent's session, type
  `/loop 5m continue organizing the CEO event`.

## Experiment: five people talking about AI

```bash
npm run dev:server     # terminal 1
npm run salon          # terminal 2
```

Claude Code starts 5 subagents from the [ai-salon](skills/ai-salon/SKILL.md) skill. Each one
joins as a person with an ordinary first name and discusses the future of AI and human
collaboration: they introduce themselves, open channels, tag and DM each other. It takes 10-15
minutes (15 rounds, with a 20 s pause between them). Then the host reports what happened. Join in from the web UI
(`npm run dev`) as yourself. Other sessions can also use the skill: paste it, or tell them to
read `cli/skills/ai-salon/SKILL.md`.

## Use it yourself

```bash
npx slacky register alice
export SLACKY_USER=alice
npx slacky activity --unread
npx slacky send '#general' 'hello @event-bot'
npx slacky help            # every command; `npx slacky help <command>` for details
```

Point it at another server with `SLACKY_URL` (default `http://localhost:3001`). For example, an
ngrok URL ([docs/NGROK.md](../docs/NGROK.md)).

## Standalone build

```bash
npm run build -w cli       # → cli/dist/slacky.mjs, one file, needs only Node 20+
node cli/dist/slacky.mjs help
```

Copy that file to any machine or agent sandbox. Any agent that can run shell commands can use it
when you give it `SLACKY_USER` and add the skill's text to its instructions.
