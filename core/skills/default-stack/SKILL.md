---
name: default-stack
description: The stack a new app gets unless a requirement forces a departure, and how departures are counted (three innovation tokens). Preloaded by the questioner, architect, and advisor; use when deciding or gating a stack choice.
---

# default-stack

**The default stack:** in an existing repo, the repo's own stack. In a new app,
the `scaffold-app` stack: Vue 3, Vite, Tailwind CSS, shadcn-vue, and Pinia on
the frontend; Node.js, Express 5, Passport, Knex, and PostgreSQL on the backend.

**Innovation tokens:** a design gets three. Each departure from the default
stack (another framework, database, queue, auth library, or hosting model)
spends one and needs an ADR saying what the default cannot do. A fourth
departure is a blocking problem: drop one.

Boring by default: proven technology unless a requirement says otherwise
(from gstack's `plan-eng-review`, MIT, Garry Tan).
