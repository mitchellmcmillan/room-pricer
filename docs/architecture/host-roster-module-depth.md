# Host Roster Module Depth Decision

Date: 2026-06-15

## Decision

Do not extract a host roster module yet.

The current host roster flow should stay in `src/App.jsx` until it gains domain behavior deeper than the component-local editing UI. The only shared rule today is the hard room auction invariant: the number of valid people must equal the number of valid rooms. That rule already lives in `auction/roster.js` and is enforced by both the host client and server.

## Deletion Test

If a new host roster module were extracted today and then deleted, the codebase would mostly lose moved JSX handlers:

- add/remove/reorder people
- add/remove/reorder rooms
- update names, emojis, descriptions, and initial prices
- show transient removal animations
- build the existing `/api/roster` payload

Those behaviours are coupled to the current form layout and do not create a deep module boundary. Extracting them now would move state setters and rendering-adjacent handlers without hiding meaningful complexity.

## Current Boundaries

- `auction/roster.js` owns roster validity.
- `src/App.jsx` owns host roster editing and rendering.
- `auction-server.js` and `auction/sqlite-persistence.js` own roster persistence and auction reset side effects.

## Revisit Triggers

Extract a host roster module only when one of these behaviours appears:

- roster import/export with normalization and validation errors
- reusable edit commands needed outside the host form
- non-trivial pricing or total-budget rules before save
- cross-field validation beyond `people.length === rooms.length`
- persistence payload migrations that need a stable client-side adapter

If one of those appears, define a pure interface first, for example:

```js
const nextRoster = applyHostRosterCommand(roster, command);
const result = prepareHostRosterSubmission(nextRoster);
```

Tests should then cover observable roster behaviour through that interface, not component internals.
