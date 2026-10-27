# VectAnim — Data-Driven Vector Graphics Editor + WPF Runtime Rendering Control

Replace bitmaps, videos and GIFs with a **declarative vector description**: draw in the web editor, bind variables,
configure animations, and export a `.vectanim.json` file. The WPF side loads that file and drives it in real time
from PLCs, sensors or business variables — **fully vector-rendered, losslessly scalable and interactive**.

Typical use cases: industrial HMI screens, mechanism motion diagrams, gauges, equipment status visualisation, process schematics.

![Editor](docs/images/01-editor.png)

> 中文版：[README.md](README.md)

---

## Quick Start

```bash
npm install            # all dependencies are installed inside the project (npm cache included)
npm run dev            # editor dev server → http://localhost:5173

npm run build          # build the editor → dist/editor/
npm run dotnet:build   # build the WPF library / demo / tests / probe
npm run dotnet:test    # 62 logic tests
npm run dotnet:probe   # offscreen rendering + pixel assertions + performance probe
npm run dotnet:pack    # package NuGet → artifacts/nuget/

npm run all            # everything above in one go (for CI)
```

Run the demo application:

```bash
dotnet run --project dotnet/VectAnim.Demo/VectAnim.Demo.csproj
```

![WPF demo](docs/images/demo-window.png)

---

## Three Modules

| Module | Technology | Responsibility |
| --- | --- | --- |
| Web editor | TypeScript + Fabric.js v7 + Vite | Drawing, variable binding, expression/keyframe animation, live preview, SVG import, JSON export |
| Data contract | `.vectanim.json` (v1.0) | The single interface between both sides, see the [Schema specification](docs/en/02-schema-specification.md) |
| WPF runtime | C# / WPF (zero third-party dependencies) | `VectAnimViewer`: parsing, variables, expressions, keyframes, `DrawingContext` vector rendering, hit testing |

## UI Language

The editor is **English by default**. The language button in the top bar switches to Simplified Chinese; the choice
is stored in `localStorage`, and `?lang=zh` forces it for a single load.
The WPF control follows the same idea: English by default, switchable through the `VECTANIM_LANG=zh-CN` environment
variable or `Strings.Culture` at runtime.

## Key Capabilities

**Editor**

- Drawing: line, rectangle (rounded), ellipse, semicircular arc, polygon, pen (smooth curves), freehand
- Editing: marquee select, `Shift`/`Ctrl` click multi-select, drag/scale/rotate, arrow-key nudge (`Shift` for 10px), grouping (a group behaves as one object), z-order, align/distribute/flip, undo & redo
- Snapping: grid snapping plus object edge/centre snapping; the tolerance stays at 6 screen pixels at any zoom level
- **Per-property binding**: any numeric or colour property can be switched between "constant" and "variable" in one click; the corresponding interaction is locked automatically after binding
- **Multi-selection batch editing**: selecting several shapes lists the properties they share, so a value or a variable binding can be applied to all of them at once
- **A group is one object**: a group has its own offset / rotation / scale / opacity, which can be bound to variables and driven by expressions or keyframes
- Variable table: create/update/delete, renaming rewrites every reference automatically, live value sliders
- Animation: expressions (`t` plus a whitelisted function set, with live syntax validation) and a keyframe timeline (drag, easing, loop, loop delay)
- Live preview: a runtime with the same semantics as the WPF side, including a warnings panel
- SVG import (rect/circle/ellipse/polygon/polyline/path → native shapes), export to JSON / PNG / SVG
- Auto-save (localStorage), drag-and-drop file import, full keyboard shortcuts

**WPF control**

- `FrameworkElement + OnRender`: no `Shape` object per figure; 200 animated figures run at about **7.5 ms/frame**
- Geometry, brushes, pens and matrices are all cached; dirty checking compares values element by element (avoiding the rare "wrong frame" caused by hash collisions)
- External variable writes take priority; `SetVariable` is safe from any thread (marshalled back to the UI thread internally) and batch writes are supported
- Expression dependencies are topologically sorted with cycle detection; keyframes support linear/eased interpolation, looping and delays
- Geometry-level hit testing (rotation aware); `ShapeClick` and hover events report the shape id and canvas coordinates
- Two render modes (Drawing / Shapes), `Stretch` fitting, `Zoom`/`Offset`, and `RenderToBitmap` for offscreen snapshots
- Fault-tolerant loading: invalid shapes and invalid expressions are skipped, missing variables resolve to 0, and every issue is reported as a validation issue or runtime warning

## Minimal Integration

```xml
<va:VectAnimViewer x:Name="Viewer" Source="panels/gear-demo.vectanim.json" AutoPlay="True" />
```

```csharp
Viewer.SetVariable("RPM", 1200);        // PLC / serial port / ViewModel alike
double angle = Viewer.GetVariable("GearAngle");
```

## Documentation

| Document | Contents |
| --- | --- |
| [01 Architecture](docs/en/01-architecture.md) | Data flow, rendering pipeline, caching strategy, coordinates and transforms, technology choices |
| [02 Schema specification](docs/en/02-schema-specification.md) | Every field, ValueRef, expression syntax and function whitelist, colour conventions, tolerance rules |
| [03 Editor user guide](docs/en/03-editor-user-guide.md) | Layout, tools, shortcuts, bindings, animation, import/export, FAQ |
| [04 WPF control API](docs/en/04-wpf-control-api.md) | Dependency properties, methods, events, threading model, integration samples, troubleshooting |
| [05 Deployment and integration](docs/en/05-deployment-and-integration.md) | Build, Nginx, NuGet, .NET Framework 4.8, deliverables |

## Verification

| Level | Command | Coverage |
| --- | --- | --- |
| Front-end unit tests | `npm test` | 62 expression assertions, keyframes, colour/path, schema round-trip, store history, variable rename propagation |
| Front-end type check | `npm run typecheck` | Strict mode (`noUnusedLocals` / `noUnusedParameters`) |
| Browser smoke test | `node tools/smoke-test.mjs` | 19 checks: drawing, polygon, undo, binding, panels, preview, SVG import, export, zero console errors |
| C# logic tests | `npm run dotnet:test` | 62 checks: expressions, keyframes, colour, matrices, JSON, validation, runtime, scene rendering/hit testing, group transforms, string-table parity |
| C# render probe | `npm run dotnet:probe` | Offscreen images + pixel-level colour assertions + frame diffing + 200-shape performance |
| Demo smoke test | `VectAnim.Demo.exe --smoke out.png` | Window snapshot plus a check that the variable panel was generated |

Rendered output and screenshots live in `artifacts/` (`wpf/*.png`, `screenshots/*.png`, `smoke-report.json`).

## Repository Layout

```
editor/                 Web editor (schema / engine / editor / ui)
dotnet/VectAnim.Wpf/    Runtime class library (the deliverable)
dotnet/VectAnim.Demo/   WPF demo application
dotnet/VectAnim.Wpf.Tests/  Dependency-free test runner
dotnet/VectAnim.RenderProbe/ Offscreen rendering probe
samples/                Sample documents (shared by the editor and the demo)
tools/                  Sample generator, browser smoke test
docs/                   Documentation
artifacts/              Build and verification output
```

## Design Decisions

- **Description and rendering are separated**: the editor only produces descriptions and performs no physics; constraint coupling (gear meshing, linkages) belongs in higher-level expressions.
- **Data-driven first**: external writes > keyframes > expressions; business state (alarms, start/stop) belongs in the ViewModel, expressions only compute geometry.
- **Expression safety**: a purpose-built lexer, parser and closure compiler with no `eval`, no reflection and a function whitelist; string literals are rejected outright.
- **Explicit colour semantics**: documents use `#AARRGGBB` (the WPF convention) while colour bindings use numeric `0xRRGGBB`, removing the alpha-position ambiguity between CSS and WPF.
- **No heavy dependencies**: the WPF library has zero third-party packages (`System.Text.Json` is built in); the editor uses no UI framework.

## License

MIT
