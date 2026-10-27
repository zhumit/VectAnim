using System.Windows;
using System.Windows.Media;
using VectAnim.Wpf.Model;
using VectAnim.Wpf.Runtime;

namespace VectAnim.Wpf.Rendering;

/// <summary>
/// Scene renderer: keeps shape render states, group visibility and draw order, and provides hit testing.
///
/// Decoupled from the control so it can be tested in isolation and reused in other hosts (printing, offscreen rendering).
/// </summary>
public sealed class SceneRenderer
{
    private readonly List<ShapeRenderState> _states = new();
    private readonly Dictionary<string, ShapeRenderState> _byId = new(StringComparer.Ordinal);
    private readonly Dictionary<string, bool> _shapeGroupVisible = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ShapeGroup> _groupOfShape = new(StringComparer.Ordinal);
    private readonly BrushCache _brushes = new();

    private VectAnimDocument _document = new();
    private VariableStore? _store;
    private Brush? _backgroundBrush;
    private string? _backgroundKey;

    /// <summary>Number of shapes.</summary>
    public int ShapeCount => _states.Count;

    /// <summary>Current document.</summary>
    public VectAnimDocument Document => _document;

    /// <summary>Loads a document (rebuilds all states).</summary>
    public void Load(VectAnimDocument document)
    {
        _document = document ?? new VectAnimDocument();
        _states.Clear();
        _byId.Clear();
        _shapeGroupVisible.Clear();
        _groupOfShape.Clear();
        _brushes.Clear();
        _backgroundKey = null;
        _backgroundBrush = null;

        foreach (var group in _document.Groups)
        {
            foreach (var shapeId in group.ShapeIds)
            {
                _shapeGroupVisible[shapeId] = group.Visible;
                _groupOfShape[shapeId] = group;
            }
        }

        // Draw in ascending ZIndex order; ties keep document order.
        var ordered = _document.Shapes
            .Select((shape, index) => (shape, index))
            .OrderBy(item => item.shape.ZIndex)
            .ThenBy(item => item.index)
            .Select(item => item.shape);

        foreach (var shape in ordered)
        {
            var state = new ShapeRenderState(shape);
            _states.Add(state);
            _byId[shape.Id] = state;
        }
    }

    /// <summary>Refreshes all shapes from the current variable values.</summary>
    /// <returns>Whether any shape changed.</returns>
    public bool Update(VariableStore store)
    {
        _store = store;
        var changed = false;
        foreach (var state in _states)
        {
            var groupVisible = !_shapeGroupVisible.TryGetValue(state.Source.Id, out var visible) || visible;
            changed |= state.Update(store, _brushes, groupVisible);
        }

        return changed;
    }

    /// <summary>Gets the background brush.</summary>
    public Brush? GetBackgroundBrush()
    {
        var key = _document.Canvas.Background;
        if (!string.Equals(_backgroundKey, key, StringComparison.Ordinal))
        {
            _backgroundKey = key;
            _backgroundBrush = ColorParser.TryParse(key, out var color) && color.A > 0
                ? _brushes.GetBrush(color)
                : null;
        }

        return _backgroundBrush;
    }

    /// <summary>Draws the whole scene (in canvas coordinates).</summary>
    public void Render(DrawingContext context)
    {
        var background = GetBackgroundBrush();
        if (background is not null)
        {
            context.DrawRectangle(background, null, new Rect(0, 0, _document.Canvas.Width, _document.Canvas.Height));
        }

        foreach (var state in _states)
        {
            // Group layer: members are drawn individually, so the group transform and opacity are
            // pushed around each member instead of around the whole group.
            if (!_groupOfShape.TryGetValue(state.Source.Id, out var group) || !state.IsVisible)
            {
                state.Draw(context);
                continue;
            }

            var matrix = BuildGroupMatrix(group, _store);
            var opacity = ResolveNumber(group.Opacity, _store, 1);
            var pushTransform = !matrix.IsIdentity;
            var pushOpacity = opacity < 0.999;

            if (pushTransform) context.PushTransform(new MatrixTransform(matrix));
            if (pushOpacity) context.PushOpacity(Math.Max(0, opacity));
            state.Draw(context);
            if (pushOpacity) context.Pop();
            if (pushTransform) context.Pop();
        }
    }

    /// <summary>
    /// Composes a group transform: translate, then rotate, then scale about the group's center.
    /// Matches the editor and the TypeScript preview renderer exactly.
    /// </summary>
    private static Matrix BuildGroupMatrix(ShapeGroup group, VariableStore? store)
    {
        var transform = group.RenderTransform;
        if (transform is null)
        {
            return Matrix.Identity;
        }

        var translate = transform.Translate;
        var rotate = transform.Rotate;
        var scale = transform.Scale;

        var tx = translate is null ? 0 : ResolveNumber(translate.X, store, 0);
        var ty = translate is null ? 0 : ResolveNumber(translate.Y, store, 0);
        var angle = rotate is null ? 0 : ResolveNumber(rotate.Value, store, 0);
        var cx = rotate is not null
            ? ResolveNumber(rotate.CenterX, store, 0)
            : scale is not null ? ResolveNumber(scale.CenterX, store, 0) : 0;
        var cy = rotate is not null
            ? ResolveNumber(rotate.CenterY, store, 0)
            : scale is not null ? ResolveNumber(scale.CenterY, store, 0) : 0;
        var sx = scale is null ? 1 : ResolveNumber(scale.ValueX, store, 1);
        var sy = scale is null ? 1 : ResolveNumber(scale.ValueY, store, 1);

        if (tx == 0 && ty == 0 && angle == 0 && sx == 1 && sy == 1)
        {
            return Matrix.Identity;
        }

        var matrix = Matrix.Identity;
        matrix.Translate(-cx, -cy);
        matrix.Scale(sx, sy);
        matrix.Rotate(angle);
        matrix.Translate(cx, cy);
        matrix.Translate(tx, ty);
        return matrix;
    }

    private static double ResolveNumber(ValueRef? reference, VariableStore? store, double fallback)
    {
        if (reference is null)
        {
            return fallback;
        }

        if (reference.IsBound)
        {
            return store is not null && reference.Variable is not null ? store.Get(reference.Variable) : fallback;
        }

        return reference.IsNumber ? reference.Number : fallback;
    }

    /// <summary>Gets the render state by ID.</summary>
    public ShapeRenderState? GetState(string shapeId) =>
        _byId.TryGetValue(shapeId, out var state) ? state : null;

    /// <summary>All render states (in draw order).</summary>
    public IReadOnlyList<ShapeRenderState> States => _states;

    /// <summary>Hit testing: returns the topmost hit shape state (input in canvas coordinates).</summary>
    public ShapeRenderState? HitTest(Point canvasPoint)
    {
        for (var index = _states.Count - 1; index >= 0; index--)
        {
            var state = _states[index];
            var point = canvasPoint;

            // Members are drawn inside their group transform, so the probe has to be mapped back
            // into member space before the state's own hit test runs.
            if (_groupOfShape.TryGetValue(state.Source.Id, out var group))
            {
                var matrix = BuildGroupMatrix(group, _store);
                if (!matrix.IsIdentity)
                {
                    matrix.Invert();
                    point = matrix.Transform(canvasPoint);
                }
            }

            if (state.HitTest(point))
            {
                return state;
            }
        }

        return null;
    }

    /// <summary>Bounding box of the scene content (canvas coordinates, transforms applied).</summary>
    public Rect ContentBounds()
    {
        var bounds = Rect.Empty;
        foreach (var state in _states)
        {
            if (!state.IsVisible)
            {
                continue;
            }

            var shapeBounds = state.TransformedBounds();
            if (shapeBounds.IsEmpty)
            {
                continue;
            }

            if (_groupOfShape.TryGetValue(state.Source.Id, out var group))
            {
                var matrix = BuildGroupMatrix(group, _store);
                if (!matrix.IsIdentity)
                {
                    shapeBounds.Transform(matrix);
                }
            }

            bounds.Union(shapeBounds);
        }

        return bounds.IsEmpty ? new Rect(0, 0, _document.Canvas.Width, _document.Canvas.Height) : bounds;
    }
}
