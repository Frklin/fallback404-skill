---
name: 404s
description: Shortcut that runs the fallback404 skill when the user types /404s.
disable-model-invocation: true
---

# /404s

The user typed `/404s`: run the fallback404 skill now, with this request (empty means none): $ARGUMENTS

In Claude Code, call the Skill tool with `fallback404:fallback404` (or `fallback404` when it was copied into a skills folder instead of installed as a plugin) and pass the request above as its arguments. Any other agent reads `../fallback404/SKILL.md`, next to this skill's folder, and follows it.
