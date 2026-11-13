# Challaghatta Rent: notes for Claude

Read `docs/HANDOFF.md` first. It has every decision, the live setup and the open items. `README.md` has the features and setup steps.

- The owner prefers to be asked when something is ambiguous or contradicts earlier decisions, rather than having the app guess. They want the reasoning behind their corrections understood and applied to later work.
- Call the person who looks after the building **Anita**. Never "security", "guard" or "helper" in anything the owner or Anita sees.
- Never store ID numbers or dates of birth. Never weaken the PIN checks, which are done on the server.
- Every push to `main` deploys to the live app. Run `npm test` before pushing; check screens with `npm run preview`.
- Schema changes go in a new numbered file in `migrations/`. Don't edit applied ones.
- End commit messages with the attribution lines from the session, if given.
