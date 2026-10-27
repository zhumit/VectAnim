# VectAnim.Wpf Control API Reference

> English | [中文](../04-WPF控件API.md)

`VectAnim.Wpf.dll` provides the custom control `VectAnimViewer`, which can be dropped into any WPF window, user control or data template.

- Target framework: `net8.0-windows` (source projects on .NET 6/7 can reference it as well, see "Deployment and integration")
- Dependencies: **none** (JSON uses `System.Text.Json`, expressions use the built-in compiler)
- Rendering: `OnRender + DrawingContext` by default; no `Shape` object is created

---

## 1. Minimal Usage

```xml
<Window xmlns:va="clr-namespace:VectAnim.Wpf.Controls;assembly=VectAnim.Wpf">
    <va:VectAnimViewer x:Name="Viewer"
                       Source="panels/gear-demo.vectanim.json"
                       AutoPlay="True" />
</Window>
```

```csharp
// Inject data from the business layer (PLC / serial port / ViewModel)
Viewer.SetVariable("RPM", 1200);

// Read a variable computed by the animation
double angle = Viewer.GetVariable("GearAngle");
```

---

## 2. Dependency Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `Source` | string | null | Document path; loading starts immediately on assignment (failure raises `LoadFailed` and keeps the previous picture) |
| `AutoPlay` | bool | false | Start the built-in animation automatically after loading |
| `AnimationEnabled` | bool | true | Master switch for the built-in animation; external variables still work when disabled |
| `AnimationSpeed` | double | 1.0 | Animation speed factor (0.5 = half speed) |
| `RenderMode` | enum | `Drawing` | `Drawing` (OnRender) / `Shapes` (creates Path visuals) |
| `Stretch` | enum | `Uniform` | `None` / `Uniform` / `UniformToFill` / `Fill` |
| `Zoom` | double | 1.0 | Additional zoom (about the control centre, 0.01–100) |
| `OffsetX` / `OffsetY` | double | 0 | Additional panning (in control coordinates) |
| `Interactive` | bool | true | Whether clicks and hovers are handled and the cursor changes |
| `ExternalWriteTimeout` | double | 0 | External write validity in milliseconds; > 0 hands control back to the animation after the timeout, 0 means permanent |

---

## 3. Methods

### 3.1 Loading

| Method | Description |
| --- | --- |
| `LoadFromFile(string path)` | Load from a file (synchronous, including validation and normalisation) |
| `LoadFromString(string json, string? sourceName = null)` | Load from JSON text (database, network, …) |
| `LoadFromDocument(VectAnimDocument doc, string? sourceName = null)` | Pass a document object directly (normalised once more) |
| `Reload()` | Reload the current source |
| `Unload()` | Unload the document and clear the picture |

> Loading failures never throw into the caller: the `LoadFailed` event is raised and the previous picture is kept — on a factory floor a single bad file must not blank the entire line.

### 3.2 Variables

| Method | Description |
| --- | --- |
| `SetVariable(string name, double value)` | Write a variable (safe from **any thread**, marshalled to the UI thread internally) |
| `SetVariables(IEnumerable<KeyValuePair<string,double>>)` | Batch write, redraws only once |
| `GetVariable(string name)` | Read the current value (0 when undefined) |
| `TryGetVariable(string name, out double value)` | Safe read |
| `HasVariable(string name)` | Whether the variable is defined |
| `ClearExternal(string? name = null)` | Clear external-write marks (pass null for all) and hand control back to the animation; **does not change the current value** |
| `ResetVariables()` | Restore all variable defaults and clear external marks |
| `IsExternallyDriven(string name)` | Whether the variable is currently driven externally |
| `BeginUpdate()` / `EndUpdate()` | Batch several changes into a single redraw |

**External write priority** (the core timing rule):

```
external business writes > keyframe animation > expression animation > variable defaults
```

Once a variable has been written externally, expressions and keyframes stop overwriting it; after `ClearExternal` the animation takes over again.

### 3.3 Playback

| Method | Description |
| --- | --- |
| `PlayAnimation()` | Start or resume playback (`t` keeps accumulating from its current value) |
| `PauseAnimation()` | Pause (`t` stops accumulating, the picture stays) |
| `StopAnimation()` | Stop and return to `t = 0` |
| `SeekAnimation(double seconds)` | Jump to a given time (useful for timeline scrubbing) |

### 3.4 Queries and Utilities

| Member | Description |
| --- | --- |
| `Document` | The current document (null when nothing is loaded) |
| `ValidationIssues` | Validation issues found while loading |
| `RuntimeWarnings` | Runtime warnings (missing variable, expression error, cyclic dependency, …) |
| `ShapeCount` / `VariableNames` | Number of shapes / collection of variable names |
| `IsAnimationPlaying` / `AnimationTime` / `AnimationDuration` | Playback state and time information |
| `HitTestShape(Point controlPoint)` | Hit test, returns the shape id |
| `ToCanvasPoint(Point controlPoint)` | Control coordinates → canvas coordinates |
| `GetViewMatrix()` | The canvas → control view matrix |
| `RenderToBitmap(double scale = 1)` | Offscreen rendering into a `BitmapSource` (printing, reports, thumbnails) |
| `Dispose()` | Release the animation hooks (recommended when the window closes) |

---

## 4. Events

### 4.1 Interaction Events (bubbling routed events)

| Event | Arguments | Description |
| --- | --- | --- |
| `ShapeClick` | `VectAnimShapeEventArgs` | Left click on a shape (topmost hit) |
| `ShapeRightClick` | as above | Right click on a shape |
| `ShapeMouseDown` / `ShapeMouseUp` | as above | Press / release over a shape |
| `ShapeMouseEnter` / `ShapeMouseLeave` | as above | Hover enter / leave |

`VectAnimShapeEventArgs` carries:

- `ShapeId` / `ShapeName`: the hit shape
- `CanvasPoint`: **canvas coordinates** (unaffected by scaling, so they can be compared directly with the JSON coordinates)
- `ControlPoint`: control coordinates
- `Button`: the mouse button that triggered it (null for hover)

```csharp
Viewer.ShapeClick += (_, e) =>
{
    if (e.ShapeId == "alarm_lamp")
    {
        MessageBox.Show($"Alarm lamp clicked at canvas ({e.CanvasPoint.X:0.#}, {e.CanvasPoint.Y:0.#})");
    }
};
```

Hit testing is **geometry based** (`FillContains` / `StrokeContains`, rotation aware) rather than bounding-box based — a click between two gear teeth is therefore not a false positive.

### 4.2 State Events

| Event | Description |
| --- | --- |
| `LoadCompleted` | Loading succeeded, carries the validation issues |
| `LoadFailed` | Loading failed, carries the exception |
| `WarningRaised` | Runtime warning (raised once per warning) |
| `VariableChanged` | A variable value changed (animation-driven or external) |
| `PlaybackStateChanged` | Playback state changed |
| `FrameRendered` | Every time a frame is rendered (useful for performance statistics) |

---

## 5. Render Modes

### Drawing (default, recommended)

```
OnRender → DrawingContext.DrawGeometry(fill, pen, geometry)
```

- No WPF object per shape, which scales far better than Canvas + Shape with many shapes;
- Geometry, brushes and pens are all cached and frozen; only matrices are updated per frame;
- Measured: 200 shapes with rotation bindings run at about **7.5 ms/frame** (including bitmap export overhead, see `VectAnim.RenderProbe`).

### Shapes

```
Path objects are kept in the visual tree; Data / Fill / Stroke / RenderTransform are updated each frame
```

- Suitable when WPF-native hit testing, `Effect` or `BitmapCache` is required;
- With many shapes the overhead is clearly higher than in Drawing mode;
- Switching is a matter of setting `RenderMode`; the rendered content is identical.

---

## 6. Threading Model

| Operation | Thread requirement |
| --- | --- |
| `SetVariable` / `SetVariables` | **Any thread** (marshalled to the UI thread internally via `Dispatcher.BeginInvoke`) |
| `ClearExternal` / `ResetVariables` / `SeekAnimation` | Any thread (same) |
| `LoadFromFile` / `LoadFromString` | UI thread recommended |
| Reading `GetVariable` | Any thread (read-only dictionary, lock-free) |

A typical PLC polling thread:

```csharp
_ = Task.Run(async () =>
{
    while (!token.IsCancellationRequested)
    {
        var snapshot = await _plc.ReadAsync();       // your own acquisition logic
        Viewer.SetVariables(snapshot);               // marshalled internally, redraws once
        await Task.Delay(50, token);
    }
});
```

> For high-frequency writes prefer `SetVariables`: one redraw instead of one `InvalidateVisual` per variable.

---

## 7. Integration Samples

### 7.1 With MVVM

```csharp
public sealed class PanelViewModel : INotifyPropertyChanged
{
    private double _rpm;
    public double Rpm
    {
        get => _rpm;
        set
        {
            _rpm = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Rpm)));
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;
}
```

```csharp
// Subscribe to the ViewModel in the View (a binding plus an attached property also works)
viewModel.PropertyChanged += (_, e) =>
{
    if (e.PropertyName == nameof(PanelViewModel.Rpm))
    {
        Viewer.SetVariable("RPM", viewModel.Rpm);
    }
};
```

### 7.2 Click an alarm to open a dialog

```csharp
Viewer.ShapeClick += async (_, e) =>
{
    if (e.ShapeId.StartsWith("alarm"))
    {
        await DialogService.ShowAsync($"Device {e.ShapeName} is in alarm, please check");
    }
};
```

### 7.3 Snapshot / printing

```csharp
var bitmap = Viewer.RenderToBitmap(2);   // 2× resolution
var encoder = new PngBitmapEncoder();
encoder.Frames.Add(BitmapFrame.Create(bitmap));
using var stream = File.Create("snapshot.png");
encoder.Save(stream);
```

### 7.4 Drag-and-drop loading

```csharp
private void OnDrop(object sender, DragEventArgs e)
{
    if (e.Data.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } files)
    {
        Viewer.LoadFromFile(files[0]);
    }
}
```

---

## 8. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Blank picture | Check `LoadFailed` and `ValidationIssues`; most often invalid path data or a canvas size of 0 |
| A shape does not follow variables | Once the variable was written externally the animation stops driving it; call `ClearExternal` or check whether an expression refers to it |
| The animation does not move | `AnimationEnabled=false`, `PlayAnimation` was never called, or all target variables were taken over externally |
| Rotation becomes slow or jitters | The expression lacks `Wrap: 360`, so floating-point error accumulates; add the modulo |
| Wrong colours / transparency | 8-digit hex was written in CSS order (`#RRGGBBAA`); use `#AARRGGBB` |
| Garbled Chinese characters | Files must be UTF-8 (BOM optional) |
| Janky with high-frequency writes | Use `SetVariables` for batch writes, or increase the acquisition interval |

`RuntimeWarnings` is the first place to look. It explains:

- The expression target variable does not exist (created as 0 automatically)
- The expression refers to an undefined variable (treated as 0)
- The expression cannot be compiled (that animation is skipped)
- Cyclic dependencies between expressions (handled in a degraded way)
- A keyframe animation without keyframes

---

## 9. Performance Tips

1. Prefer `RenderMode="Drawing"`.
2. Do not write constants in any form other than `{"Const": ...}` (bindings add per-frame resolution overhead — small, but avoidable).
3. With many shapes, avoid adding a rotation binding to every shape; bind only what really has to move.
4. With `Stretch="None"` and a fixed size, WPF does not need to recompute the view matrix per frame.
5. For high-frequency data (> 30 Hz) implement **change detection** in the business layer and call `SetVariable` only when the value really changed.
6. Use `RenderToBitmap` for export; do not call `RenderTargetBitmap` repeatedly on the UI thread.

---

## 10. UI Language (localization)

The control's own messages (validation issues, runtime warnings, the demo UI) come from the built-in string table
`VectAnim.Wpf.Localization.Strings`:

- **English by default**; Simplified Chinese ships as the second language. Both tables are compiled into the
  assembly — no `.resx` satellite assemblies, so single-file publishing stays simple.
- Set the `VECTANIM_LANG=zh-CN` (or `zh`) environment variable before start-up, or change `Strings.Culture` at runtime.
- `Strings.T("key")` looks a key up and falls back to English, then to the key itself; `Strings.MissingKeys` lists
  missing translations for self-checks.

```csharp
Strings.Culture = new CultureInfo("zh-CN");   // switch at runtime
string text = Strings.T("Demo.ShapeCountFormat", 10);
```

> `Strings` only covers the control's and the demo's own messages. It does **not** translate anything inside a
> `.vectanim.json` (shape names, variable names and notes are document data).
