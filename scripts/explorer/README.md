# Spectator chunk explorer and village waypoints

Used for Smeo444 on 2026-11-08 (New World (3)). Copy these into a bot's brain/state folder and start the explorer through the eval channel:

- `explore.js`: square spiral flight in spectator mode, gated on chunks ahead being loaded; progress in `explore.json`.
- `explore-boot.js`: autopilot off, `/gamemode spectator`, resume the spiral and a per-chunk bell scanner (villages in `villages.json`).
- `village-waypoints.js`: run with node; keeps a "Villages" set in the Xaero minimap waypoint file for the world, Greek and Roman names.
