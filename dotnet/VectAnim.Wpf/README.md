# VectAnim.Wpf

Runtime rendering control for VectAnim: loads a declarative `.vectanim.json` vector description and drives it from
external business data (PLC / sensors / business variables), with fully vector rendering, lossless scaling and
interaction.

- Target framework: `net8.0-windows`
- Dependencies: **none** (JSON through the built-in `System.Text.Json`, expressions through the built-in compiler)
- Rendering: `OnRender + DrawingContext`, no Shape objects created

## Installation

```xml
<PackageReference Include="VectAnim.Wpf" Version="1.0.0" />
```

## Usage

```xml
<Window xmlns:va="clr-namespace:VectAnim.Wpf.Controls;assembly=VectAnim.Wpf">
    <va:VectAnimViewer x:Name="Viewer"
                       Source="panels/gear-demo.vectanim.json"
                       AutoPlay="True"
                       ShapeClick="OnShapeClick" />
</Window>
```

```csharp
// Inject variables (safe from any thread)
Viewer.SetVariable("RPM", 1200);
Viewer.SetVariables(new Dictionary<string, double>
{
    ["Temp"] = 62.5,
    ["Alarm"] = 1,
});

// Read a value computed by the animations
double angle = Viewer.GetVariable("GearAngle");

// Playback control
Viewer.PlayAnimation();
Viewer.SeekAnimation(1.5);
Viewer.StopAnimation();

// Hit testing / snapshot
string? id = Viewer.HitTestShape(new Point(120, 80));
BitmapSource png = Viewer.RenderToBitmap(2);
```

## Key behaviours

| Behaviour | Description |
| --- | --- |
| External writes win | A variable written from outside is no longer overwritten by expressions or keyframes until `ClearExternal()` |
| Tolerant loading | Bad shapes and bad expressions are skipped, missing variables read as 0, and problems are reported through `ValidationIssues` / `RuntimeWarnings` |
| Threading model | `SetVariable` may be called from any thread; the control marshals back to the UI thread |
| Render mode | `Drawing` (default, high performance) / `Shapes` (creates Path visual objects) |
| Colour | Documents use `#AARRGGBB`; colour bindings use the numeric `0xRRGGBB` |

## Documentation

The full API, schema and integration notes live in the repository `docs/` folder (English mirrors under `docs/en/`):

- `docs/en/02-schema-specification.md`
- `docs/en/04-wpf-control-api.md`
- `docs/en/05-deployment-and-integration.md`

## License

MIT
