# Editor User Guide

> English | [中文](../03-编辑器使用手册.md)

Open `dist/editor/index.html` (or run `npm run dev` and visit http://localhost:5173). The editor is **entirely front-end**:
no backend is required and all file I/O happens locally.

---

## 1. UI Layout

```
┌──────┬────────────────┬──────────────────────────────────────────────────┐
│ Top bar: file / undo-redo / zoom / grid & snap / export / preview / help │
├──────┼────────────────┼──────────────────────────────────────────────────┤
│ Tool │ Layers         │                                                  │
│ bar  │ (groups and    │        Canvas (Fabric.js)                        │
│      │  shapes)       │                                                  │
│      │                │  [ Properties / Variables / Animation panels ]   │
├──────┴────────────────┴──────────────────────────────────────────────────┤
│ Status: cursor / selection / counts / history / zoom                     │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Canvas**: the white area in the middle is exactly the exported canvas; the dark area is the workspace. The mouse wheel pans, `Ctrl+wheel` zooms, and `Space` + drag pans temporarily.
- **Layers**: groups first, then ungrouped shapes, ordered by ZIndex from top to bottom. The eye icon toggles visibility; double-click a name to rename.
- **Right panel**: `Properties` (geometry / appearance / transform / bindings), `Variables` (variable table plus live value sliders), `Animation` (expressions plus the keyframe timeline).

---

## 2. Drawing

| Tool | Shortcut | Interaction |
| --- | --- | --- |
| Select | `V` | Click, marquee (drag on empty canvas), drag, scale (corner handles), rotate (top handle) |
| Line | `L` | Press and drag to the end point |
| Rectangle | `R` | Drag a box; hold `Shift` for a square (it stays square after release) |
| Ellipse | `E` | Drag a box; hold `Shift` for a circle (it stays circular after release) |
| Semicircular arc | `A` | Drag to set the **diameter** (start → end is the chord), radius = chord / 2; `Shift` snaps the diameter to 45° steps, `Alt` flips the bulge direction |
| Polygon | `P` | Click points one by one; `Enter` or double-click to close (at least 3 points) |
| Pen | `N` | Click points to generate a **smooth curve** (Catmull-Rom → Bézier) |
| Freehand | `F` | Press and drag to draw any curve; the shape is simplified and smoothed on release |
| Pan | `H` | Drag to move the canvas |

A semicircular arc is stored as a `Path` shape (`M` + `A` commands, unfilled by default), so it supports property
bindings, scaling/rotation and native rendering through `Geometry.Parse` on the WPF side. Turn on the fill colour in
the properties panel if you want a half disc instead.

**Grid snapping** and **object snapping** (to other shapes' edges and centres) are enabled while drawing; turn them off with the magnet button in the top bar. Grid display is toggled with the grid button.

> The snapping tolerance is fixed at 6 screen pixels and stays responsive at any zoom level.

---

## 3. Editing Operations

| Operation | Shortcut |
| --- | --- |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) |
| Copy / paste / duplicate | `Ctrl+C` / `Ctrl+V` / `Ctrl+D` |
| Duplicate by dragging | Hold `Ctrl` and drag a selected shape: the original stays in place, a copy follows the pointer and settles where you release. Release `Ctrl` mid-drag to cancel the copy |
| Select all | `Ctrl+A` |
| Delete | `Delete` / `Backspace` |
| Group / ungroup | `Ctrl+G` / `Ctrl+Shift+G` |
| Move up / down one layer | `Ctrl+]` / `Ctrl+[` |
| Bring to front / send to back | `Ctrl+Shift+]` / `Ctrl+Shift+[` |
| Nudge | Arrow keys move 1 px, `Shift+arrow` moves 10 px |
| Fit to window | `Ctrl+0` |
| Zoom in / out | `Ctrl+=` / `Ctrl+-` |
| Export JSON | `Ctrl+S` |
| Open | `Ctrl+O` |
| New | `Ctrl+N` |
| Live preview | `F5` |
| Help | `F1` |

With a multi-selection the properties panel shows a toolbar with **align / distribute / flip / group**.

**Pasting offsets the copy**: each paste is shifted by 16 px and consecutive pastes keep accumulating (`Ctrl+C` resets
the counter), so pasted shapes never land on top of the original. `Ctrl+D` offsets by 16 px as well.

**A group behaves as one object**: after `Ctrl+G`, clicking any member on the canvas selects the whole group, and
dragging, scaling, rotating, nudging with the arrow keys or deleting all apply to the group. `Ctrl+Shift+G` ungroups.
Clicking a **single shape row** in the layers panel still selects just that shape, which is handy for editing its
properties.

### Marquee selection

With the select tool active, **press and drag on an empty part of the canvas** to pull out a selection box:

| Interaction | Effect |
| --- | --- |
| Drag on empty canvas | **Marquee**: every shape whose bounding box intersects the box is selected, with a live dashed preview |
| `Shift` / `Ctrl` + click | **Multi-select**: add to / remove from the selection (clicking a selected shape deselects it) |
| `Shift` + drag | The marquee result is **merged** into the current selection |
| Click on empty canvas | Clear the selection |

> The marquee has to start on **empty canvas**. If it starts on a shape (a full-canvas background, for instance), you
> drag that shape instead. To marquee the whole artboard, start outside the artboard in the dark workspace.

---

## 4. Variables

Open the `Variables` tab and click `+` in the top-right corner.

Each variable has a name, default value, minimum/maximum, unit and description. The name must match `^[A-Za-z_][A-Za-z0-9_]*$` because expressions refer to it.

- **Renaming rewrites every reference**: shape bindings, expression text and animation targets are all updated (matched on identifier boundaries, so the `RPM` inside `RPMTotal` is never touched).
- **Deleting a variable lists its usages first**; afterwards the related bindings fall back to the constant 0 and the related animations are removed.
- The slider below each variable card writes an "external value", equivalent to `SetVariable` on the WPF side, and can be used to validate data-driven behaviour; the `external write` badge indicates that the variable is currently owned externally.

---

## 5. Properties and Bindings

After selecting a shape, the properties panel groups its fields as `geometry / appearance / transform / bindings`.

Every animatable property has a **link icon** on its right:

1. Click it to open the variable list;
2. Pick a variable and the property becomes a binding (the input is locked and turns purple, showing the variable's current value live);
3. Pick "Create a variable and bind…" to create a variable with the property's name and bind it in one step;
4. Pick "Unbind" to fall back to a constant.

Behaviour once bound:

- The shape **follows the variable in real time** on the canvas;
- The matching manual interaction is **locked** to avoid conflicts:
  - position properties bound → no dragging
  - size properties bound → no scaling
  - rotation angle bound → no rotating
- The `variable bindings` group lists every binding of the shape and can unbind them in one click.

### Colour Bindings

Colour properties can also be bound, but variables are numeric, hence the convention: **a number is interpreted as a `0xRRGGBB` integer**.

```
LampColor = 0x00FF00 → green
LampColor = 0xFF0000 → red
```

Combined with an expression this yields an alarm lamp:

```
if(Alarm > 0.5, 16711680, 65280)
```

### 5.1 Multi-selection: editing common properties

Select two or more shapes (`Shift`/`Ctrl` click, or marquee) and the properties panel lists the properties **all of
them share** (`Fill`, `Stroke`, `Stroke width`, `Opacity`, `Rotation`, …). Editing one applies it to every selected
shape:

- properties whose values differ show as `Mixed` and stay untouched until a new value is typed;
- the link icon on the right still binds the whole selection to one variable, or unbinds it;
- `Variables in the selection` lists the variables the selection depends on and how many shapes use each one;
- `Align` (align / distribute / flip) and `Organize` (group / z-order / duplicate / delete) remain below.

> Only properties that **every** selected shape has are listed: selecting a rectangle and a polygon together will
> not offer `Width`, which only the rectangle has.

### 5.2 Groups: one object made of many

Selecting all members of a group (clicking the group header in the layers panel does exactly that) switches the
properties panel into **group mode**:

- **`Group transform`**: `Offset X/Y`, `Rotation` (around the group center), `Scale X/Y`, plus the
  `Rotate −90° / +90° / Reset / Reset transform` shortcuts;
- **`Appearance`**: `Opacity`, multiplied with each member's own opacity;
- **`Members`**: the member list; clicking a row selects that shape on its own;
- **`Variable bindings`**: the group's own bindings, each removable in one click;
- **`Organize`**: ungroup, bring to front / send to back, flip.

These properties bind to variables exactly like shape properties, so expressions and keyframe animations can drive
them — bind a variable to a group's `Rotation` and the whole group turns.

Two things worth knowing:

- Dragging / scaling / rotating a group on the canvas still **bakes into each member's geometry** (unchanged
  behaviour) and leaves the group transform at the identity.
- The group transform is an **additional layer on top of the members**, which is what makes binding and animation
  possible. Its rotation/scale pivot is set to the group's bounding-box center the first time it is edited.

---

## 6. Animation

The `Animation` tab contains two kinds of animation, and both may be used at the same time.

With a shape (or a whole group) selected, a **`Related to the selection`** group appears at the top of the panel and
lists the animations driving it (matched through the bound variables); clicking a row jumps to that animation card.

### 6.1 Expression Animations

Best suited for real-time driving (speed, angle, displacement). Fill in:

- **Target variable**: which variable receives the result
- **Expression**: for example `RPM * 6 * t` (`t` is in seconds)
- **Wrap**: for example `360` to loop angles and avoid floating-point accumulation error

Below the input the syntax check updates live: `✓ syntax ok · uses t · depends on RPM`, or a red error message with the position.

### 6.2 Keyframe Animations

- **Click on empty space** in the timeline to add a keyframe;
- Drag a diamond to change its time;
- Double-click a diamond to edit the exact time, value and easing;
- Right-click to delete a keyframe;
- Tick "loop" and use the number on the right for the pause between loops.

The timeline length equals the last keyframe's time.

---

## 7. Live Preview

Click `Live preview` in the top bar (`F5`):

- A runtime with the **same semantics** as the WPF side drives the preview canvas;
- Playback, pause, stop and timeline scrubbing are available;
- The variable sliders on the right inject values in real time, equivalent to PLC writes;
- Runtime warnings (undefined variables, expression errors, cyclic dependencies, …) are shown at the bottom.

> The preview and the editor share the same variable table: moving a slider in the preview also updates the bound shapes on the editor canvas.

---

## 8. Import / Export

| Operation | Notes |
| --- | --- |
| Open a `.vectanim.json` file | Files can be dragged into the window; errors open an issue list |
| Import SVG | rect / circle / ellipse / polygon / polyline / path become native shapes (text and images are skipped with a notice) |
| Export `.vectanim.json` | A strict validation runs first; errors block the export and are listed |
| Export PNG | 2× resolution, a snapshot of the current variable values |
| Export SVG | Vector snapshot, handy for slides and documents |

**Auto-save**: edits are written to the browser's localStorage (protection against crashes) and restored on the next visit. Choosing "New" asks before overwriting.

---

## 9. FAQ

**Q: A shape on the canvas will not move.**
A: Its position, size or angle is bound to a variable. Unbind it in the "variable bindings" group, or change the variable value instead.

**Q: The exported JSON shows nothing in WPF.**
A: Check `ValidationIssues` / `RuntimeWarnings` on the WPF side first; the most common causes are invalid path data or a canvas size of 0.

**Q: Why is there no `Scale` in the exported JSON?**
A: The editor bakes scaling into the geometry (width/height, radii, vertices, path coordinates) so the WPF side reads real sizes. See section 10 of `02-schema-specification.md`.

**Q: The colours and transparency look wrong.**
A: Documents use `#AARRGGBB` (alpha first), the opposite of CSS `#RRGGBBAA`. The editor converts automatically; mind the order when writing files by hand.

**Q: There are too many undo steps.**
A: Consecutive edits of the same property collapse into one history entry (700 ms window); at most 120 entries are kept.
