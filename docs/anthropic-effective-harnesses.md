# Anthropic: Effective Harnesses for Long-Running Agents

> 原文: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

As AI agents become more capable, developers are increasingly asking them to take on complex tasks requiring work that spans hours, or even days. However, getting agents to make consistent progress across multiple context windows remains an open problem.

The core challenge of long-running agents is that they must work in discrete sessions, and each new session begins with no memory of what came before. Imagine a software project staffed by engineers working in shifts, where each new engineer arrives with no memory of what happened on the previous shift. Because context windows are limited, and because most complex projects cannot be completed within a single window, agents need a way to bridge the gap between coding sessions.

We developed a two-fold solution to enable the Claude Agent SDK to work effectively across many context windows: an **initializer agent** that sets up the environment on the first run, and a **coding agent** that is tasked with making incremental progress in every session, while leaving clear artifacts for the next session.

## The Long-Running Agent Problem

The Claude Agent SDK is a powerful, general-purpose agent harness adept at coding, as well as other tasks that require the model to use tools to gather context, plan, and execute. It has context management capabilities such as compaction, which enables an agent to work on a task without exhausting the context window. Theoretically, given this setup, it should be possible for an agent to continue to do useful work for an arbitrarily long time.

However, compaction isn't sufficient. Out of the box, even a frontier coding model like Opus 4.5 running on the Claude Agent SDK in a loop across multiple context windows will fall short of building a production-quality web app if it's only given a high-level prompt, such as "build a clone of claude.ai."

Claude's failures manifested in two patterns:

1. **One-shotting the app**: The agent tended to try to do too much at once. Often, this led to the model running out of context in the middle of its implementation, leaving the next session to start with a feature half-implemented and undocumented.

2. **Premature completion**: After some features had already been built, a later agent instance would look around, see that progress had been made, and declare the job done.

This decomposes the problem into two parts:

1. **Initial environment setup**: Lay the foundation for all features, setting up the agent to work step-by-step and feature-by-feature.
2. **Incremental progress**: Each agent should make progress while leaving the environment in a "clean state" - code that would be appropriate for merging to main: no major bugs, orderly and well-documented.

## The Two-Part Solution

### 1. Initializer Agent

The very first agent session uses a specialized prompt that asks the model to set up the initial environment:

- An `init.sh` script
- A `claude-progress.txt` file that keeps a log of what agents have done
- An initial git commit that shows what files were added

### 2. Coding Agent

Every subsequent session asks the model to:

- Make incremental progress
- Leave structured updates for the next session

The key insight: finding a way for agents to quickly understand the state of work when starting with a fresh context window, accomplished with the progress file alongside git history.

## Environment Management

### Feature List

To address premature completion, the initializer agent writes a comprehensive file of feature requirements. For the claude.ai clone example, this meant **over 200 features**, such as "a user can open a new chat, type in a query, press enter, and see an AI response."

All features are initially marked as "failing" so later agents have a clear outline of what full functionality looks like.

```json
{
  "category": "functional",
  "description": "New chat button creates a fresh conversation",
  "steps": [
    "Navigate to main interface",
    "Click the 'New Chat' button",
    "Verify a new conversation is created",
    "Check that chat area shows welcome state",
    "Verify conversation appears in sidebar"
  ],
  "passes": false
}
```

**Key insight**: Use JSON instead of Markdown - the model is less likely to inappropriately change or overwrite JSON files.

### Incremental Progress

The coding agent is asked to work on **only one feature at a time**. This incremental approach was critical to addressing the agent's tendency to do too much at once.

After making code changes, the model must:

1. Commit progress to git with descriptive commit messages
2. Write summaries of progress in a progress file

This allows using git to revert bad code changes and recover working states.

### Testing

A major failure mode: Claude tends to mark features as complete without proper testing. Without explicit prompting, Claude makes code changes and does unit tests, but fails to recognize that the feature doesn't work end-to-end.

**Solution**: Explicitly prompt Claude to use browser automation tools and do all testing as a human user would.

Providing testing tools (like Puppeteer MCP) dramatically improved performance, as the agent could identify and fix bugs that weren't obvious from code alone.

## Getting Up to Speed

Every coding agent is prompted to run through these steps:

1. Run `pwd` to see the directory you're working in
2. Read the git logs and progress files to get up to speed
3. Read the features list file and choose the highest-priority undone feature

**Best practice**: Ask the initializer agent to write an `init.sh` script that can run the development server, then run through a basic end-to-end test before implementing a new feature.

### Typical Session Start

```
[Assistant] I'll start by getting my bearings and understanding the current state of the project.
[Tool Use] <bash - pwd>
[Tool Use] <read - claude-progress.txt>
[Tool Use] <read - feature_list.json>
[Assistant] Let me check the git log to see recent work.
[Tool Use] <bash - git log --oneline -20>
[Assistant] Now let me check if there's an init.sh script to restart the servers.
<Starts the development server>
[Assistant] Excellent! Now let me navigate to the application and verify that some fundamental features are still working.
<Tests basic functionality>
[Assistant] Based on my verification testing, I can see that the fundamental functionality is working well...
<Starts work on a new feature>
```

## Failure Modes and Solutions Summary

| Problem | Initializer Agent Behavior | Coding Agent Behavior |
|---------|---------------------------|----------------------|
| Claude declares victory too early | Set up a feature list file with end-to-end feature descriptions | Read feature list at session start. Choose a single feature to work on. |
| Claude leaves environment with bugs or undocumented progress | Write initial git repo and progress notes file | Start by reading progress notes and git logs, run basic tests. End session with git commit and progress update. |
| Claude marks features as done prematurely | Set up a feature list file | Self-verify all features. Only mark "passing" after careful testing. |
| Claude has to figure out how to run the app | Write an `init.sh` script | Start session by reading `init.sh`. |

## Future Work

Open questions remain:

1. **Single vs. Multi-agent**: Is a single general-purpose coding agent best, or would specialized agents (testing, QA, cleanup) perform better?

2. **Generalization**: This demo is optimized for full-stack web app development. Future direction is to generalize to other fields like scientific research or financial modeling.
