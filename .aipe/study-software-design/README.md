# buffr — software design audit (APOSD, applied)

A code-level design audit of **buffr** using the primitives from John Ousterhout's *A Philosophy of Software Design* (APOSD): deep modules, information hiding, complexity, layering, readability. Findings are grounded in real files — not generic principle restatements. Where buffr's design honors a primitive, the audit names where and why; where it doesn't, the audit names the file:line and the move to fix it.

This is the second of two design audits at different altitudes. The other:

- **`.aipe/study-system-design-dsa/`** — system architecture + DSA (services, scaling, data structures, sync engine mechanics, the LWW conflict rule).
- **`.aipe/study-software-design/`** (this guide) — module/interface-level design quality (deep vs shallow modules, leakage, layering smells, readability).

If both seem to want the same finding, the rule is altitude: module/interface/complexity belongs here; service/architecture/algorithm belongs there.

## The through-line

> Complexity is the enemy. Deep modules are the weapon.

Everything in this guide ties back to one question — *where, in buffr, does complexity bite, and which APOSD primitive does the fix come from?* The audit ranks findings worst-first: the file you'd open in a code review and ask about first, before the long list.

## Reading order

```
   the audit in eight concepts — each anchored to real files

   01 complexity-in-this-codebase     ── zoom-out: where complexity lives
                                          (the diagnostic; ranks hotspots)
       │
       ▼
   02 deep-vs-shallow-modules         ── modules ranked by depth
       │                                 (functionality ÷ interface size)
       ▼
   03 information-hiding-and-leakage  ── facts known in two places
                                          (the seams where leaks live)
       │
       ▼
   04 layers-and-abstractions          ── pass-through methods, layers
                                          that don't earn their place
       │
       ▼
   05 pull-complexity-downward         ── knobs exposed to callers a
                                          module had enough info to own
       │
       ▼
   06 errors-and-special-cases         ── try/except scatter; special
                                          cases a different definition
                                          would erase
       │
       ▼
   07 readability                      ── names · comments · consistency
                                          · obviousness, four facets
       │
       ▼
   08 red-flags-audit                  ── consolidated checklist marked
                                          against this repo. The capstone.
```

## What you'll find here vs the rest of the family

This guide cross-references rather than re-teaches. For the **conceptual depth** of any APOSD primitive (the chapter-style book treatment), read `read-aposd` (the per-chapter book guide). For **system-level** complexity (sync engine choice, conflict-resolution rules, scaling), read `.aipe/study-system-design-dsa/`. This guide's contribution is the **findings**: where in buffr each principle fires, what file:line range to open, and the one-line fix.

If a finding here cites a system-design primitive (e.g., the sync engine's silent-error guard), the file references the system-design-dsa entry rather than re-walking the architecture. Inheritance, not duplication.

## Source

The audit's framework is John Ousterhout's *A Philosophy of Software Design* (Yaknyam, 2018, 2nd ed. 2021). Read the book for the framework; read this guide for what buffr looks like through that framework. The findings are original; the primitive names are the book's.
