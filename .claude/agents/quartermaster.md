---
name: quartermaster
description: "PLACEHOLDER — NOT IMPLEMENTED. DO NOT DISPATCH. This file exists only to reserve the cost-and-speed agent and rule tag Q so a future session does not hand the letter to something else. It has no charter and no rules. Its subject, when built, is what MAELLE costs and how fast she answers at runtime — not the framework's own spend, which is the architect's. Tracked as gh#172. Write the real charter only on the owner's say-so."
tools: Read
model: sonnet
---

# Quartermaster — reserved, not built

**Do not dispatch this agent.** It has no rules. Tracked as **gh#172** (Improvement · Low · Framework); the owner builds it when he chooses.

## Why the file exists

The letter `Q` is held for this lane. Owner's call, 2026-08-01. Unlike the Whatsapper the design here is *settled* — name, letter, scope and shape were all decided — and only the charter is unwritten. This file is that decision, kept where the next session will find it.

## Name and letter

A quartermaster accounts for every unit consumed **and** runs the supply line, so it covers both halves: what a turn costs and how long it takes. The money-only alternatives (Bookkeeper, Bursar, Treasurer) record rather than optimise; Timekeeper covers only speed.

`quartermaster` returns **0** hits in `src/` and `.claude/`. `Q` is free — the 13 remaining `Q[0-9]` tokens in `src/` are fiscal quarters inside prompt strings (`"focused on Q3 targets"`), which nobody reads as a rule tag. Same ruling that cleared `SlackMaster` against 733 uses of the word *slack*. Confirm the count before minting the tag.

## What it is, and what it is not

**Non-builder.** It measures and files; it does not edit. An efficiency agent that changes code crosses every lane's territory at once — Matchmaker's calls, Gatekeeper's guards, Instructor's prompt — so it hands each finding to the owning lane instead.

**Whole-project and periodic**, like the cleaner. That makes two agents that read all of Maelle: the cleaner asks *is this dead*, the quartermaster asks *what does this cost per turn*. Both are **provable** — cost is measurable — which is what makes this a cleaner-shaped agent rather than a judgment one. The bouncer is not in this pair: it reads one wave's diff at the gate, not the whole project.

**Its subject is Maelle's runtime, not the framework's.** The architect owns framework spend (A2 measure never estimate, A10 fewer round trips) and `scripts/spend.cjs` already measures agent cost. This agent's subject is what Maelle spends serving a person: calls per turn, tokens per turn, model tier per call, guard cost on the always-on path, and latency. **That is owned by nobody today** — only Gatekeeper's *"cheap in model, count and time"* touches runtime cost, and **nothing anywhere mentions latency.**

## Candidate rules

Not a charter — a starting list, kept because each one is a thing a model gets wrong by default, which is the test for whether the agent earns its boot cost. Measured 2026-08-01.

- **A call on the always-on path is paid every turn.** One added guard is not one call, it is one call per turn forever.
- **Tier down before optimising.** The model tier is a config line and several-fold; turn-count work buys 10–20%.
- **Prompt tokens are paid on every turn, not once.** A prompt addition is a recurring cost, not a one-off.
- **Measure before claiming.** Three confident cost claims in one day were all wrong, and each pointed at building the wrong thing.
- **A cached read is not a free read.** Cache reads cost the same *count* on any model at a very different price.
- **Latency is a product property, not a byproduct.** A correct answer that arrives too late has failed at what it was for.

Six clears the floor; the upper guideline is 15.

## Prerequisite — already in place

Its findings must persist. The write duty for hand-dispatched whole-project agents is in `SESSION_STARTER.md` (X120), and the mapping onto existing ledger verdicts is in the Manager skill. The quartermaster rides the same path as the cleaner and needs no new mechanism.

## Not in scope

Editing code. Framework spend. Anything the architect already owns.
