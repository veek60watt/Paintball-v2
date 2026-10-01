# Paperball

First-person paintball on **your real street**, rebuilt from OpenStreetMap in a flat cut-paper cartoon style. No API keys, no build step.

## Run
```bash
cd paperball
python3 -m http.server 8080
# open http://localhost:8080
```
Must be served over HTTP (ES modules). Opening `index.html` from disk won't work.

## Pick your street
| Method | Example |
|---|---|
| Start-screen search box | `Maple Ave, Enid OK` |
| URL by address | `http://localhost:8080/?q=Maple+Ave+Enid+OK` |
| URL by coordinates | `http://localhost:8080/?lat=36.3956&lon=-97.8784` |

Search reloads the page with `?lat=&lon=` so every location is bookmarkable/shareable. Default is downtown Enid. If OpenStreetMap is unreachable, an offline sample block loads instead (the start screen says so).

## What's real vs. guessed
| From OSM (accurate) | Inferred (best guess) |
|---|---|
| Street layout and street names on corner signs | Wall/roof color unless tagged in OSM |
| Building footprints, positions, orientation | Roof type unless `roof:shape` is tagged (rectangles → gable/hip) |
| Stories/height when tagged | Which wall is the front (faces nearest road) |
| Trees, driveways, footpaths when mapped | Window/door placement, chimneys |

No house numbers are read or rendered. Detail quality is only as good as your area's OSM mapping — improving it on openstreetmap.org improves the game.

## Controls
| Desktop | Mobile | Action |
|---|---|---|
| WASD | Left-thumb joystick | Move |
| Mouse | Drag right side | Aim |
| Click | ● (hold = auto-fire) | Fire |
| Space | ⤒ | Jump |
| Shift | — | Sprint |
| Esc | — | Release mouse |

Paint all 10 neighbors to win.

## Files
| File | Role |
|---|---|
| `js/config.js` | All tunables (radius, counts, speeds, perf caps) |
| `js/geo.js` | Geocoding, Overpass fetch, OSM → world data, fallback |
| `js/houses.js` | House generator: walls, gable/hip/flat roofs, doors/windows, colliders |
| `js/toon.js` | Paper-cutout materials, ink outlines, sky/clouds |
| `js/streets.js` | Roads, curbs, sidewalks, street-name signs, trees, spawn point |
| `js/game.js` | Physics, player, controls (desktop + mobile), paintballs, targets, HUD |
| `js/main.js` | Boot + start screen |
| `CONTRACT.md` | Module interfaces and coordinate conventions |

## Known limitations
1. Building courtyards (inner rings) ignored; complex footprints get simplified roofs.
2. Overpass/Nominatim are free public services — rapid reloads can get throttled (fallback kicks in).
3. Requires Chrome 89+ / Safari 16.4+ / Firefox 108+ (import maps).
4. Mobile is functional but tested only in an emulated iPhone viewport.

## License
Code: MIT. Map data © OpenStreetMap contributors, ODbL.
