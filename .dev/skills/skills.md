---
title: skills
category: skills
scope: global
---
---
name: solo-dev-stack
description: >
  Use this skill for any coding, architecture, or implementation task involving this stack:
  Next.js, React, TypeScript, Node.js, Netlify (including Netlify Blobs), LangChain.js,
  and serverless patterns. Trigger this skill whenever the user is building, debugging, scaffolding,
  or designing anything in this stack — even if they don't explicitly name all the technologies.
  Also use when discussing deployment, environment config, API routes, edge functions, or AI/LLM
  integrations in this ecosystem.
---

# Solo Dev Stack Skill

This skill captures a standard tech stack for solo-built productivity tools and side projects.
Use it to make decisions, write code, and architect solutions that are consistent with this tooling.

---

## Stack Overview

| Layer | Technology |
|---|---|
| Framework | Next.js (App Router) |
| UI | React + Tailwind CSS |
| Language | TypeScript |
| Runtime | Node.js |
| Deployment | Netlify |
| Storage | Netlify Blobs (when applicable) |
| AI/LLM | LangChain.js |
| Architecture | Serverless (Netlify Functions / Next.js API routes) |

---

## Defaults & Conventions

### Next.js
- Use the **App Router** (`app/` directory) by default.
- Prefer **Server Components** unless interactivity requires `"use client"`.
- API routes live in `app/api/[route]/route.ts`.
- Keep page files as thin wrappers; push logic into feature modules.

### TypeScript
- Strict mode enabled.
- Prefer `type` over `interface` unless extending.
- Avoid `any`; use `unknown` and narrow properly.
- Co-locate types with the feature they belong to.

### Tailwind CSS
- Use utility classes directly; avoid custom CSS unless necessary.
- Follow BEM naming if custom class names are needed.
- Dark mode via `dark:` variants.

### Netlify
- Use **Netlify Functions** for serverless endpoints (or Next.js API routes deployed to Netlify).
- Environment variables via Netlify dashboard + `.env.local` for dev.
- Netlify Blobs for lightweight key-value / blob storage (no external DB needed for simple persistence).

### LangChain.js
- Use for LLM chains, prompt templates, and tool/agent orchestration.
- Prefer `RunnableSequence` / LCEL patterns over legacy `LLMChain`.
- Keep model config (temperature, model name) in environment variables.
- Use streaming where UX benefits from it.

### Serverless Patterns
- Keep functions stateless; pass all needed context in the request.
- Avoid long-running synchronous operations — use streaming or polling patterns.
- Bundle size matters; import only what's needed from large packages.

---

## Solo Dev Principles

Architectures should:
- Be **low-maintenance** — prefer simple, well-understood patterns over clever ones.
- Be **iterative** — support incremental feature additions without big rewrites.
- Avoid unnecessary external services; use Netlify's built-in features where possible.
- Optimize for a single developer: clear structure, fast local dev, minimal ops overhead.

---

## Code Style

- Functional components only; no class components.
- Named exports for components; default export for page files.
- Descriptive variable names over comments where possible.
- Keep files focused; split early rather than letting files grow large.
- Feature-first directory structure, not layer-first.

---

## Common Patterns

### Netlify Blob read/write
```ts
import { getStore } from "@netlify/blobs";

const store = getStore("my-store");
await store.set("key", JSON.stringify(data));
const raw = await store.get("key");
const value = raw ? JSON.parse(raw) : null;
```

### LangChain.js chain (LCEL)
```ts
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";

const model = new ChatOpenAI({ model: process.env.OPENAI_MODEL, temperature: 0 });
const prompt = PromptTemplate.fromTemplate("Answer this: {question}");
const chain = prompt.pipe(model).pipe(new StringOutputParser());
const result = await chain.invoke({ question: "What is LangChain?" });
```

### Next.js API route (App Router)
```ts
// app/api/example/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();
  // ...
  return NextResponse.json({ result });
}
```