# Architecture

> English | [中文](../01-架构设计.md)

## 1. Overall Structure

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  Web editor (TypeScript)     │        │  WPF runtime (C#)            │
│                              │        │                              │
│  Fabric.js canvas            │        │  VectAnimViewer              │
│    <-> project / write-back  │        │    <->                       │
│  EditorStore (single source) │        │  VectAnimRuntime             │
│    <->                       │        │    <->                       │
│  Schema validate / serialize │        │  SceneRenderer               │
│    <->                       │        │    <->                       │
│  Runtime (preview)           │        │  DrawingContext              │
└──────────────────────────────┘        └──────────────────────────────┘
               │                                       │
               └─────────── .vectanim.json ────────────┘
                    (single data contract)
```

Three modules and two boundaries:

1. The **editor** only produces descriptions; it performs no physics.
2. The **schema** is the single contract; each side implements "parse → runtime model → render" on its own.
3. The **runtime** only consumes the description plus variables and never writes back to the document.

## 2. Editor Data Flow

```
User action
   ↓
tool / canvas event
   ↓
command (commands.ts)
   ↓
EditorStore.update()
   ├──→ CanvasView.render(doc)      project the document into Fabric
   └──→ panels rebuild              properties / variables / animation
```

Key design points:

- **Single source of truth**: `EditorStore` owns an immutable document. The Fabric canvas is a *projection* of it, not a data source.
- **Dragging does not touch the document**: while dragging, scaling or rotating, only Fabric's internal state changes; everything is written back once on `object:modified`, so the document is never cloned per frame.
- **Write-back bakes transforms**: `scaleX/scaleY` are folded into the geometry while the rotation is kept as `RenderTransform.Rotate`, so the document always stores "real size plus one angle".
- **Binding locks**: once a property is bound to a variable, the matching interaction is locked (position → no dragging, size → no scaling, angle → no rotation) so manual edits and data-driven updates cannot fight each other.
- **History coalescing**: consecutive edits of the same property (within 700 ms, same coalesce key) collapse into a single undo entry.

## 3. Runtime Semantics Shared by Both Sides

Expressions, keyframes and external-write priority are **implemented twice** (TypeScript and C#) but aligned rule by rule, with matching unit tests. Code sharing was rejected deliberately: sharing across languages means either code generation or WASM, both of which raise deployment complexity, while these three areas are small enough (about 600 lines per side) that alignment is cheaper than sharing.

Alignment matrix:

| Semantics | TypeScript | C# |
| --- | --- | --- |
| Lexer / parser / precedence | `engine/expression.ts` | `Expressions/ExpressionLexer.cs`, `ExpressionParser.cs` |
| Function whitelist and degree-based trigonometry | `EXPRESSION_FUNCTIONS` | `ExpressionFunctions.cs` |
| Keyframe sampling and easing | `engine/keyframes.ts` | `Animation/KeyframeSampler.cs` |
| Variable priority and dependency ordering | `engine/runtime.ts` | `Runtime/VectAnimRuntime.cs` |
| Colour semantics | `engine/color.ts` | `Rendering/ColorParser.cs` |

Both sides test the same cases, for example `mod(-30,360)=330`, `EaseIn` staying below 0.5 at the midpoint, and the sampled value at `t=6` with `loopDelay=1`.

## 4. Rendering Pipeline (WPF)

```
LoadDocument
  ├─ DocumentValidator.Normalize   fill defaults / drop invalid nodes / sort keyframes
  ├─ VectAnimRuntime.LoadDocument  variable table + compile expressions + topo sort + first frame
  └─ SceneRenderer.Load            create ShapeRenderState per shape (ordered by ZIndex)

Every frame (CompositionTarget.Rendering or SetVariable)
  ├─ runtime.Advance(dt)           advance t, recompute expressions/keyframes, report "changed"
  ├─ scene.Update(store)           resolve properties per shape -> dirty check -> rebuild geometry if needed
  └─ InvalidateVisual -> OnRender
        └─ background -> per shape PushTransform/PushOpacity -> DrawGeometry -> Pop
```

### 4.1 Caching Strategy

| Object | Cache | Invalidation |
| --- | --- | --- |
| Geometry | `Geometry` (frozen) | resolved values of geometry-related properties change (element-wise signature comparison) |
| Brushes | `SolidColorBrush` (frozen, keyed by ARGB) | colour changes |
| Pens | `Pen` (frozen, keyed by colour/thickness/cap/join) | any of the above changes |
| Transform | one reused `MatrixTransform`, only `Matrix` is assigned | transform values change |
| View matrix | computed per frame from `Stretch`/`Zoom`/`Offset` (pure arithmetic, no allocation) | — |

Dirty checking in `ShapeRenderState.Update` compares values **element by element** instead of using a hash, which eliminates the hardest class of bug to diagnose: an occasional wrong frame caused by a hash collision.

### 4.2 Why Not WPF Shapes

- Every `Shape` is a visual-tree node with a property system, layout and hit-testing overhead.
- With 200 figures, the per-frame cost of `Canvas + Shape` is dominated by the property system and layout, not by drawing.
- `DrawingContext.DrawGeometry` writes drawing instructions straight into the render tree; with frozen geometry and pens the cost approaches pure drawing.

Measured (`VectAnim.RenderProbe`, 200 rectangles with rotation bindings, including `RenderTargetBitmap` export overhead): **about 7.5 ms per frame**.

### 4.3 Two Render Modes

- `Drawing`: draw directly in `OnRender` (the default).
- `Shapes`: add `Path` objects to a `VisualCollection` and synchronise `Data/Fill/Stroke/RenderTransform` each frame. Useful when WPF-native effects or hit testing are required.

Both modes share the same `SceneRenderer` state and produce identical output.

## 5. Coordinate System and Transforms

### 5.1 Unified Coordinates

- World coordinates equal canvas coordinates: origin at the top-left corner, Y pointing down, unit = DIP.
- All geometry fields of all shapes are in world coordinates (except `Path`, which uses local coordinates plus `OffsetX/Y`).
- The rotation centre `CenterX/CenterY` is also in world coordinates.

### 5.2 Transform Order

```
p' = T(translate) · T(center) · R(angle) · S(scale) · T(-center) · p
```

WPF `Matrix` methods *append* (the first call is applied first), so the code must call them in the order **Scale → Rotate → Translate**:

```csharp
var m = Matrix.Identity;
m.ScaleAt(sx, sy, cx, cy);
m.RotateAt(angle, cx, cy);
m.Translate(tx, ty);
```

There is a dedicated test case for this (`Scale, then rotate, then translate`) because getting the order wrong only shifts the figure slightly — almost impossible to spot by eye.

### 5.3 Handling the Fabric.js Difference

Fabric describes an object with `left/top + originX/Y=center + scaleX/scaleY + angle`. On export:

1. `object.getCenterPoint()` becomes the world-space centre;
2. `scaleX/scaleY` are baked into the geometry (rectangle width/height, ellipse radii, vertices scaled about the centre, path coordinates scaled with a recomputed `Offset`);
3. `angle` is written to `RenderTransform.Rotate.Value`;
4. lines bake the rotation into their endpoints directly (avoiding rotation-centre ambiguity).

As a result the only pixel differences between the editor canvas and the WPF output come from anti-aliasing and stroke rounding — there is no coordinate offset.

## 6. Error Handling Strategy

| Stage | Strategy |
| --- | --- |
| Import | Tolerant: fix what can be fixed (defaults, de-duplication, dropping invalid nodes) and record every `Issue` |
| Export | Strict: error-level issues block the export and are reported with the field path |
| Runtime load | Tolerant + warnings: skip broken shapes, skip broken expressions, treat missing variables as 0 |
| Rendering | A single failing shape never breaks the whole picture (geometry construction is wrapped in try/catch and the shape is skipped) |
| Interaction | Hit testing uses geometry instead of bounding boxes to avoid false positives |

## 7. Repository Layout

```
VectAnimEditor/
├─ editor/                      # Web editor
│  ├─ index.html
│  └─ src/
│     ├─ schema/                # Data contract: types / validation / serialization / factories
│     ├─ engine/                # Shared runtime semantics + Canvas2D renderer
│     ├─ editor/                # Editor logic: store / canvas / commands / geometry / SVG import / export
│     ├─ ui/                    # Panels and the main program (no UI framework)
│     ├─ styles/                # Dark industrial stylesheet
│     └─ tests/                 # Vitest unit tests
├─ dotnet/
│  ├─ VectAnim.Wpf/             # Runtime class library (the deliverable)
│  ├─ VectAnim.Demo/            # WPF demo application (with a --smoke snapshot mode)
│  ├─ VectAnim.Wpf.Tests/       # Console test runner (zero dependencies)
│  └─ VectAnim.RenderProbe/     # Offscreen render probe (pixel assertions + performance)
├─ samples/                     # Sample documents (shared by the editor and the demo)
├─ tools/                       # Sample generator / smoke test
├─ docs/                        # Documentation (docs/en holds the English version)
└─ artifacts/                   # Build and verification output (screenshots, renders, NuGet packages)
```

## 8. Technology Choices

| Choice | Rationale | Alternatives rejected |
| --- | --- | --- |
| Fabric.js v7 | Mature canvas interaction (drag/scale/rotate/marquee) out of the box | A hand-written canvas interaction layer is a lot of work and easy to get wrong |
| Vite 8 + TS 5.9 | Fast builds, type safety, pure static output | Webpack is configuration-heavy; without a build step TypeScript is not available |
| No UI framework | The panels are tables and forms; about 2k lines of hand-written DOM avoids framework size and version risk | Element Plus and friends add 100 KB+ and make theming expensive |
| Purpose-built expression engine | Controllable whitelist, no reflection, no `eval`, semantics can be aligned rule by rule between TS and C# | NCalc exposes too much surface (a larger attack surface) and is hard to align with the TypeScript side |
| System.Text.Json | Built into .NET, zero dependencies, fast | Newtonsoft.Json needs an extra package with overlapping features |
| Flat shape structure | Simple deserialisation, good tolerance, identical across languages | Polymorphic serialisation (STJ polymorphism or custom resolution) is complex and error-prone |
