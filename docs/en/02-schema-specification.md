# VectAnim Schema Specification (v1.0)

> English | [中文](../02-Schema规范.md)

`.vectanim.json` is the **single data contract** between the editor and the WPF runtime. This document is authoritative: any field change must be applied here, in the editor (TypeScript) and in the runtime (C#) at the same time.

- File suffix: `.vectanim.json` (plain UTF-8 JSON; comments and trailing commas are accepted)
- Top-level version field: `"SchemaVersion": "1.0"`
- Coordinate system: **origin at the top-left corner (0,0), X to the right, Y downwards**, unit = WPF device-independent pixel (DIP)
- Angle unit: **degrees (°)**, clockwise positive (matching `Fabric.angle` and `RotateTransform.Angle`)
- Naming: every JSON field is PascalCase, so C# deserialisation needs no name mapping

---

## 1. Top-Level Structure

```jsonc
{
  "SchemaVersion": "1.0",
  "Canvas": { ... },                 // required
  "Variables": [ ... ],              // variable table
  "Shapes": [ ... ],                 // shape collection (flat structure)
  "ExpressionAnimations": [ ... ],   // expression animations
  "KeyframeAnimations": [ ... ],     // keyframe animations
  "Groups": [ ... ],                 // groups (flat; a shape belongs to at most one group)
  "Meta": { ... }                    // optional: title, author and other metadata
}
```

Apart from `Canvas`, every array may be omitted (an omitted array is treated as empty).

### Canvas

| Field | Type | Description |
| --- | --- | --- |
| `Width` | number | Canvas width, must be > 0; falls back to 800 when invalid |
| `Height` | number | Canvas height, must be > 0; falls back to 600 when invalid |
| `Background` | string | Background colour, see "Colour conventions" |

### Meta (optional)

`Title` / `Description` / `Author` / `CreatedAt` / `UpdatedAt`. Pure metadata, not involved in rendering.

---

## 2. Property Value Union (ValueRef)

Every animatable numeric or colour property of a shape uses the same structure:

```jsonc
{ "Const": 300 }        // constant
{ "Const": "#FF0000" }  // constant (colour / text)
{ "Bind": "GearAngle" } // variable binding
```

Rules:

1. `Const` accepts number / string / boolean; numeric properties are coerced to number and raise an error when the conversion is impossible.
2. `Bind` refers to a `Variables[].Name`. When the variable does not exist the runtime uses **0** and raises a warning (it never throws).
3. `Fill` / `Stroke` set to `null` or `{ "Const": null }` mean "no fill" / "no stroke".
4. A binding never changes the shape definition itself: the constant value stays in the document and is used again after unbinding.

---

## 3. Variable Table

```jsonc
{
  "Name": "RPM",
  "DefaultValue": 1200,
  "Description": "Drive shaft speed",
  "Min": 0,
  "Max": 3000,
  "Unit": "r/min",
  "Decimals": 0
}
```

| Field | Required | Description |
| --- | --- | --- |
| `Name` | yes | Variable name, recommended pattern `^[A-Za-z_][A-Za-z0-9_]*$` (expressions refer to it) |
| `DefaultValue` | yes | Default value (0 when omitted) |
| `Min` / `Max` | no | Value range, used for sliders and clamping hints only; the runtime does not force clamping |
| `Unit` | no | Unit of measurement |
| `Decimals` | no | Number of decimal places to display |

Duplicate names keep the first definition and raise a warning.

---

## 4. Shapes

All shapes share the following fields:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `Id` | string | — | Unique identifier (duplicates are renamed automatically with a warning) |
| `Name` | string | = Id | Display name, returned by interaction events |
| `Type` | string | — | `Line` / `Rectangle` / `Ellipse` / `Polygon` / `Path`; unknown types are dropped |
| `IsVisible` | bool | true | Visibility |
| `ZIndex` | number | 0 | Layer order, **higher values are on top**; equal values follow array order |
| `Opacity` | ValueRef | 1 | Opacity 0..1 (extension field) |
| `Fill` | ValueRef \| null | null | Fill |
| `Stroke` | ValueRef \| null | null | Stroke |
| `StrokeThickness` | ValueRef | 1 | Stroke width |
| `LineCap` | string | `Flat` | `Flat` / `Round` / `Square` (extension field) |
| `LineJoin` | string | `Miter` | `Miter` / `Bevel` / `Round` (extension field) |
| `RenderTransform` | object | none | Transform, see below |

> "Extension field" means an optional addition in v1.0: when omitted it is an identity/default behaviour, and older readers can ignore it without drawing anything wrong.

### 4.1 RenderTransform

```jsonc
"RenderTransform": {
  "Rotate":    { "CenterX": {"Const":300}, "CenterY": {"Const":300}, "Value": {"Bind":"GearAngle"} },
  "Scale":     { "CenterX": {"Const":300}, "CenterY": {"Const":300}, "ValueX": {"Const":1}, "ValueY": {"Const":1} },
  "Translate": { "X": {"Const":0}, "Y": {"Const":0} }
}
```

**The transform order is fixed: scale → rotate → translate.** Both scaling and rotation happen around `CenterX/CenterY`.

Mathematically (p is a local coordinate of the shape):

```
p' = T(Translate) · T(Center) · R(Angle) · S(Scale) · T(-Center) · p
```

Corresponding WPF code:

```csharp
var m = Matrix.Identity;
m.ScaleAt(sx, sy, cx, cy);
m.RotateAt(angle, cx, cy);
m.Translate(tx, ty);
```

### 4.2 Line

```jsonc
{ "Type": "Line", "X1": {...}, "Y1": {...}, "X2": {...}, "Y2": {...} }
```

The editor bakes rotation into the endpoints on export (`RenderTransform` is empty) to avoid rotation-centre ambiguity.

### 4.3 Rectangle

```jsonc
{ "Type": "Rectangle", "X": {...}, "Y": {...}, "Width": {...}, "Height": {...},
  "RadiusX": {...}, "RadiusY": {...} }
```

`X/Y` is the top-left corner **before rotation**; `RadiusX/Y` is the corner radius (extension field, clamped to half of the width/height).

### 4.4 Ellipse

```jsonc
{ "Type": "Ellipse", "CenterX": {...}, "CenterY": {...}, "RadiusX": {...}, "RadiusY": {...} }
```

### 4.5 Polygon

```jsonc
{ "Type": "Polygon",
  "Points": [ { "X": {"Const":0}, "Y": {"Const":0} }, ... ],
  "IsClosed": true }
```

Vertices are in world coordinates; `IsClosed: false` produces a polyline (no fill).

### 4.6 Path

```jsonc
{ "Type": "Path", "Data": "M 10,10 L 110,10 L 110,60 Z", "OffsetX": 0, "OffsetY": 0 }
```

- `Data` uses the **WPF Path Mini-Language** (`StreamGeometry` syntax): `M/L/H/V/C/S/Q/T/A/Z`, with an optional `F0` prefix for even-odd filling.
- Path coordinates are **local**; `OffsetX/OffsetY` translate the local origin into world coordinates.
- Rotation is still expressed through `RenderTransform.Rotate`, with the centre in world coordinates.
- Loading performs a strict character-level validation (WPF's `Geometry.Parse` is far too lenient with trailing garbage); an invalid path is dropped as a whole and reported as an error.

---

## 5. Groups

```jsonc
{ "GroupId": "group_gear", "Name": "Gear assembly", "ShapeIds": ["gear_01"], "Visible": true,
  "Opacity": { "Const": 1 },
  "RenderTransform": { "Rotate": { "CenterX": { "Const": 300 }, "CenterY": { "Const": 300 },
                                  "Value": { "Bind": "GearAngle" } } },
  "Locked": false }
```

- Flat structure: **a shape belongs to at most one group** (duplicate membership is ignored with a warning).
- When `Visible=false` the members are hidden as well (logical AND with each member's own `IsVisible`).
- `Opacity` is an extension field and multiplies with the members' opacity. It is a regular `ValueRef`, so it can be
  bound to a variable; for hand-written files a **bare number** (`"Opacity": 0.4`) is read as `{ "Const": 0.4 }`.
- `RenderTransform` is an extension field applied **on top of every member's own transform**, in the same order as
  for shapes: translate, then rotate about `CenterX/CenterY`, then scale about the same center. The field structure
  is identical to a shape's `RenderTransform`, so a group can be bound to variables and driven by expressions or
  keyframes exactly like a single shape.
- Dragging / scaling / rotating a group in the editor still **bakes into the member geometry**; the group
  `RenderTransform` is an additional layer and starts as the identity (no offset, no rotation, scale 1).
- `Locked` is an editor-only concept and is ignored by the runtime.

---

## 6. Expression Animations

```jsonc
{ "Id": "expr_gear_rotate", "TargetVariable": "GearAngle",
  "Expression": "RPM * 6 * t", "Enabled": true, "Wrap": 360 }
```

- `Expression` is evaluated every frame (and after every external write); the result is written to `TargetVariable`.
- Available symbols: every name in `Variables` plus the time `t` (seconds, accumulated since playback started; pauses do not accumulate).
- `Wrap` is an extension field: the result is taken modulo `Wrap` using Euclidean modulo (`mod(-30,360)=330`), commonly used for looping angles.
- When several expressions depend on each other the runtime performs a **topological sort** so that dependencies are computed first within the same frame; cycles are reported as warnings and handled in a degraded way.
- If the target variable was written externally, the expression is skipped for that frame (external priority).

### 6.1 Expression Syntax

| Precedence | Operators |
| --- | --- |
| lowest | `? :` (ternary) |
| ↓ | `\|\|` |
| ↓ | `&&` |
| ↓ | `==` `!=` |
| ↓ | `<` `<=` `>` `>=` |
| ↓ | `+` `-` |
| ↓ | `*` `/` `%` |
| ↓ | unary `-` `+` `!` |
| highest | `^` (right associative, `2^3^2 = 512`) |

- Booleans are represented as `1/0`; comparisons return `1/0`.
- Division by zero returns `0` (never `Infinity`/`NaN`).
- **String literals and user-defined functions are not supported**: they are rejected at the lexer stage, which makes injection impossible by construction.

### 6.2 Function Whitelist

| Function | Description |
| --- | --- |
| `sin cos tan` | Trigonometry (**argument in degrees**) |
| `asin acos atan atan2` | Inverse trigonometry (**result in degrees**) |
| `sqrt abs min max pow` | Basic maths |
| `floor ceil round(x[,digits]) trunc sign` | Rounding |
| `exp ln log(x[,base]) log10` | Logarithms |
| `clamp(v,lo,hi) lerp(a,b,t) mod(a,b)` | Range / interpolation / modulo |
| `deg(rad) rad(deg)` | Angle conversion |
| `if(cond,a,b)` | Conditional selection (equivalent to the ternary operator) |

Constants: `pi`, `e`, `true`, `false`.

> `mod(-30, 360) = 330` (the result is always non-negative); `%` is the C-style remainder (the sign follows the dividend).

---

## 7. Keyframe Animations

```jsonc
{ "Id": "kf_pointer", "Name": "Pointer sweep", "TargetVariable": "PointerX",
  "Loop": true,
  "Keyframes": [
    { "Time": 0, "Value": 380, "Easing": "EaseInOut" },
    { "Time": 2, "Value": 450, "Easing": "EaseInOut" },
    { "Time": 4, "Value": 380, "Easing": "EaseInOut" }
  ],
  "Enabled": true, "LoopDelay": 0 }
```

Sampling rules:

1. Keyframes are sorted by `Time` ascending; **for duplicate timestamps the last one wins**.
2. Before the first keyframe the first value is used; after the last keyframe the last value is used.
3. The loop period is the last keyframe time plus `LoopDelay`; inside the delay window the last value is held.
4. Easing comes from the **starting keyframe** and applies up to the next keyframe:
   - `Linear` (default), `Step` (hold), `EaseIn` (t²), `EaseOut` (1-(1-t)²), `EaseInOut`
5. `Enabled: false` disables the whole animation.

---

## 8. Colour Conventions

| Form | Interpretation |
| --- | --- |
| `#AARRGGBB` | 8-digit hex, **alpha first** (WPF convention; the editor emits this form) |
| `#RRGGBB` / `#RGB` | Opaque |
| `rgb(...)` / `rgba(r,g,b,a)` / `hsl(...)` | CSS forms, parsed for compatibility |
| Named colours | `Red`, `SteelBlue`, `transparent`, … |
| Numeric | Interpreted as a `0xRRGGBB` integer (**colour bindings** only, e.g. `0xFF0000` = red) |

> ⚠️ Note that CSS 8-digit hex is `#RRGGBBAA` (alpha last), which differs from this specification.
> The editor converts everything to `#AARRGGBB` before export; follow `#AARRGGBB` when writing files by hand.

Colour binding example:

```jsonc
{ "Name": "LampColor", "DefaultValue": 65280 },   // 0x00FF00 green
...
{ "Type": "Ellipse", "Fill": { "Bind": "LampColor" } }
```

---

## 9. Loading Tolerance and Validation

The runtime loads in two steps — "normalise, then render" — and every repair is recorded as a validation issue (`ValidationIssue`):

| Situation | Handling |
| --- | --- |
| Missing `Id` | Generated as `shape_N` |
| Duplicate `Id` | Renamed with a warning |
| Unknown `Type` | Shape dropped and reported as an error |
| Invalid path | Shape dropped and reported as an error |
| Polygon with fewer than 2 points | Dropped |
| Group referencing a missing shape | Removed from the group |
| Expression syntax error | Animation dropped |
| Duplicate variable definition | First definition kept |
| Invalid canvas size | Falls back to 800×600 |
| Bound variable does not exist | Resolved as 0 at runtime + warning |
| Comments / trailing commas in JSON | Parsed normally |

---

## 10. Coordinate Conversion Contract with the Editor

Fabric.js describes transforms with an object centre plus scale factors, while this schema requires "real geometry plus a rotation". The editor's exporter therefore does three things:

1. **Bakes scaling**: `width *= scaleX`, `radius *= scaleX/scaleY`, vertices scaled about the centre, path coordinates scaled as a whole;
2. **Keeps rotation**: written as `RenderTransform.Rotate{ CenterX, CenterY, Value }`, with the centre being the shape centre in world coordinates;
3. **Bakes translation**: lines rewrite their endpoints directly; paths rewrite `OffsetX/OffsetY`.

Consequently a document **never contains `RenderTransform.Scale`** (unless it was hand-written, or an imported SVG requires non-uniform scaling). This keeps `Width`/`RadiusX` as real sizes on the WPF side and removes the "width is 10 but it looks like 40" ambiguity from the property panel.
