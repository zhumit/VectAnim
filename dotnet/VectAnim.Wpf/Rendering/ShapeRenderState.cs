using System.Windows;
using System.Windows.Media;
using VectAnim.Wpf.Model;
using VectAnim.Wpf.Runtime;

namespace VectAnim.Wpf.Rendering;

/// <summary>
/// Render state and caches for a single shape.
///
/// Key performance decisions:
///  - Geometry is rebuilt only when the resolved value of a geometry-related property changes (constant shapes build once);
///  - Brushes/pens come from <see cref="BrushCache"/> instead of being allocated every frame;
///  - The transform matrix reuses one <see cref="MatrixTransform"/> instance and only updates its value;
///  - No WPF Shape objects are created; everything is drawn through DrawingContext.
/// </summary>
public sealed class ShapeRenderState
{
    private readonly MatrixTransform _matrixTransform = new();

    private Geometry? _geometry;
    private double[] _geometrySignature = Array.Empty<double>();
    private string? _geometryData;
    private int _geometryLength;

    private Brush? _fill;
    private Pen? _pen;
    private uint _fillKey;
    private uint _strokeKey;
    private double _strokeThicknessKey;
    private PenLineCap _capKey;
    private PenLineJoin _joinKey;
    private bool _paintValid;

    private ResolvedTransform _transform;
    private double _opacity = 1;
    private bool _visible = true;
    private bool _matrixValid;

    public ShapeRenderState(ShapeDefinition source)
    {
        Source = source;
        ZIndex = source.ZIndex;
    }

    /// <summary>Source definition.</summary>
    public ShapeDefinition Source { get; }

    /// <summary>Z-order.</summary>
    public double ZIndex { get; }

    /// <summary>Whether currently visible.</summary>
    public bool IsVisible => _visible;

    /// <summary>Geometry bounding box (transform not applied).</summary>
    public Rect GeometryBounds => _geometry?.Bounds ?? Rect.Empty;

    /// <summary>Pen used for drawing (reused by hit testing).</summary>
    public Pen? CurrentPen => _pen;

    /// <summary>Current geometry (reused by the Shapes render mode).</summary>
    public Geometry? Geometry => _geometry;

    /// <summary>Current fill brush.</summary>
    public Brush? FillBrush => _fill;

    /// <summary>Current pen.</summary>
    public Pen? StrokePen => _pen;

    /// <summary>Current opacity.</summary>
    public double Opacity => _opacity;

    /// <summary>Current transform.</summary>
    public ResolvedTransform Transform => _transform;

    /// <summary>
    /// Refreshes the resolved values from the current variable values.
    /// </summary>
    /// <returns>Whether anything affecting drawing changed.</returns>
    public bool Update(VariableStore store, BrushCache cache, bool groupVisible)
    {
        var changed = false;
        var source = Source;

        var visible = source.IsVisible && groupVisible;
        if (visible != _visible)
        {
            _visible = visible;
            changed = true;
        }

        var opacity = Math.Clamp(Resolve(source.Opacity, store, 1), 0, 1);
        if (!opacity.Equals(_opacity))
        {
            _opacity = opacity;
            changed = true;
        }

        // Pen/brush
        var fillColor = ResolveColor(source.Fill, store);
        var strokeColor = ResolveColor(source.Stroke, store);
        var thickness = Math.Max(0, Resolve(source.StrokeThickness, store, 1));
        var cap = ToPenCap(source.LineCap ?? LineCapStyle.Flat);
        var join = ToPenJoin(source.LineJoin ?? LineJoinStyle.Miter);

        var fillKey = fillColor.HasValue ? ToKey(fillColor.Value) : 0u;
        var strokeKey = strokeColor.HasValue ? ToKey(strokeColor.Value) : 0u;
        if (!_paintValid || fillKey != _fillKey || strokeKey != _strokeKey ||
            !thickness.Equals(_strokeThicknessKey) || cap != _capKey || join != _joinKey)
        {
            _fill = fillColor.HasValue ? cache.GetBrush(fillColor.Value) : null;
            _pen = strokeColor.HasValue && thickness > 0
                ? cache.GetPen(strokeColor.Value, thickness, cap, join)
                : null;
            _fillKey = fillKey;
            _strokeKey = strokeKey;
            _strokeThicknessKey = thickness;
            _capKey = cap;
            _joinKey = join;
            _paintValid = true;
            changed = true;
        }

        // Transform
        var transform = ResolveTransform(source, store);
        if (!TransformEquals(transform, _transform))
        {
            _transform = transform;
            _matrixValid = false;
            changed = true;
        }

        // Geometry
        if (RebuildGeometryIfNeeded(store))
        {
            changed = true;
        }

        return changed;
    }

    /// <summary>Draws to the context (in canvas coordinates).</summary>
    public void Draw(DrawingContext context)
    {
        if (!_visible || _geometry is null)
        {
            return;
        }

        var hasTransform = !_transform.IsIdentity;
        if (hasTransform)
        {
            if (!_matrixValid)
            {
                _matrixTransform.Matrix = _transform.ToMatrix();
                _matrixValid = true;
            }

            context.PushTransform(_matrixTransform);
        }

        var hasOpacity = _opacity < 1;
        if (hasOpacity)
        {
            context.PushOpacity(_opacity);
        }

        context.DrawGeometry(_fill, _pen, _geometry);

        if (hasOpacity)
        {
            context.Pop();
        }

        if (hasTransform)
        {
            context.Pop();
        }
    }

    /// <summary>Hit testing (input in canvas coordinates).</summary>
    public bool HitTest(Point canvasPoint, bool allowStrokeOnly = true)
    {
        if (!_visible || _geometry is null)
        {
            return false;
        }

        var point = canvasPoint;
        if (!_transform.IsIdentity)
        {
            var matrix = _transform.ToMatrix();
            if (!matrix.HasInverse)
            {
                return false;
            }

            matrix.Invert();
            point = matrix.Transform(point);
        }

        if (_fill is not null && _geometry.FillContains(point))
        {
            return true;
        }

        return allowStrokeOnly && _pen is not null && _geometry.StrokeContains(_pen, point);
    }

    /// <summary>Computes the bounding box after applying the transform.</summary>
    public Rect TransformedBounds()
    {
        if (_geometry is null)
        {
            return Rect.Empty;
        }

        var bounds = _geometry.Bounds;
        if (_transform.IsIdentity)
        {
            return bounds;
        }

        var matrix = _transform.ToMatrix();
        var corners = new[]
        {
            bounds.TopLeft,
            bounds.TopRight,
            bounds.BottomRight,
            bounds.BottomLeft,
        }.Select(matrix.Transform).ToArray();

        var minX = corners.Min(point => point.X);
        var minY = corners.Min(point => point.Y);
        var maxX = corners.Max(point => point.X);
        var maxY = corners.Max(point => point.Y);
        return new Rect(minX, minY, maxX - minX, maxY - minY);
    }

    private bool RebuildGeometryIfNeeded(VariableStore store)
    {
        var values = CollectGeometryValues(store, out var data);
        if (_geometry is not null && SignatureEquals(values, data))
        {
            return false;
        }

        _geometry = BuildGeometry(values, data);
        _geometrySignature = values;
        _geometryLength = values.Length;
        _geometryData = data;
        return true;
    }

    private double[] CollectGeometryValues(VariableStore store, out string? data)
    {
        var source = Source;
        data = null;

        switch (source.Type)
        {
            case ShapeKind.Line:
                return new[]
                {
                    Resolve(source.X1, store, 0),
                    Resolve(source.Y1, store, 0),
                    Resolve(source.X2, store, 0),
                    Resolve(source.Y2, store, 0),
                };

            case ShapeKind.Rectangle:
                return new[]
                {
                    Resolve(source.X, store, 0),
                    Resolve(source.Y, store, 0),
                    Math.Max(0, Resolve(source.Width, store, 0)),
                    Math.Max(0, Resolve(source.Height, store, 0)),
                    Math.Max(0, Resolve(source.RadiusX, store, 0)),
                    Math.Max(0, Resolve(source.RadiusY, store, 0)),
                };

            case ShapeKind.Ellipse:
                return new[]
                {
                    Resolve(source.CenterX, store, 0),
                    Resolve(source.CenterY, store, 0),
                    Math.Max(0, Resolve(source.RadiusX, store, 0)),
                    Math.Max(0, Resolve(source.RadiusY, store, 0)),
                };

            case ShapeKind.Polygon:
            {
                var points = source.Points ?? new List<PointRef>();
                var values = new double[(points.Count * 2) + 1];
                for (var index = 0; index < points.Count; index++)
                {
                    values[index * 2] = Resolve(points[index].X, store, 0);
                    values[(index * 2) + 1] = Resolve(points[index].Y, store, 0);
                }

                values[^1] = source.IsClosed == false ? 0 : 1;
                return values;
            }

            case ShapeKind.Path:
                data = source.Data ?? string.Empty;
                return new[] { source.OffsetX ?? 0, source.OffsetY ?? 0 };

            default:
                return Array.Empty<double>();
        }
    }

    private Geometry? BuildGeometry(double[] values, string? data)
    {
        try
        {
            switch (Source.Type)
            {
                case ShapeKind.Line:
                {
                    var geometry = new StreamGeometry();
                    using (var context = geometry.Open())
                    {
                        context.BeginFigure(new Point(values[0], values[1]), isFilled: false, isClosed: false);
                        context.LineTo(new Point(values[2], values[3]), isStroked: true, isSmoothJoin: false);
                    }

                    geometry.Freeze();
                    return geometry;
                }

                case ShapeKind.Rectangle:
                {
                    var rect = new Rect(values[0], values[1], values[2], values[3]);
                    var radiusX = Math.Min(values[4], values[2] / 2);
                    var radiusY = Math.Min(values[5], values[3] / 2);
                    var geometry = new RectangleGeometry(rect, radiusX, radiusY);
                    geometry.Freeze();
                    return geometry;
                }

                case ShapeKind.Ellipse:
                {
                    var geometry = new EllipseGeometry(new Point(values[0], values[1]), values[2], values[3]);
                    geometry.Freeze();
                    return geometry;
                }

                case ShapeKind.Polygon:
                {
                    if (values.Length < 3)
                    {
                        return null;
                    }

                    var closed = values[^1] > 0.5;
                    var geometry = new StreamGeometry();
                    using (var context = geometry.Open())
                    {
                        context.BeginFigure(new Point(values[0], values[1]), isFilled: closed, isClosed: closed);
                        for (var index = 2; index + 1 < values.Length - 1; index += 2)
                        {
                            context.LineTo(new Point(values[index], values[index + 1]), isStroked: true, isSmoothJoin: false);
                        }
                    }

                    geometry.Freeze();
                    return geometry;
                }

                case ShapeKind.Path:
                {
                    if (string.IsNullOrWhiteSpace(data))
                    {
                        return null;
                    }

                    var geometry = Geometry.Parse(data);
                    if (values.Length >= 2 && (values[0] != 0 || values[1] != 0))
                    {
                        geometry.Transform = new TranslateTransform(values[0], values[1]);
                    }

                    geometry.Freeze();
                    return geometry;
                }

                default:
                    return null;
            }
        }
        catch
        {
            return null;
        }
    }

    private bool SignatureEquals(double[] values, string? data)
    {
        if (_geometryLength != values.Length || !string.Equals(_geometryData, data, StringComparison.Ordinal))
        {
            return false;
        }

        for (var index = 0; index < values.Length; index++)
        {
            if (!values[index].Equals(_geometrySignature[index]))
            {
                return false;
            }
        }

        return true;
    }

    private static bool TransformEquals(ResolvedTransform left, ResolvedTransform right) =>
        left.Angle.Equals(right.Angle) &&
        left.CenterX.Equals(right.CenterX) &&
        left.CenterY.Equals(right.CenterY) &&
        left.ScaleX.Equals(right.ScaleX) &&
        left.ScaleY.Equals(right.ScaleY) &&
        left.TranslateX.Equals(right.TranslateX) &&
        left.TranslateY.Equals(right.TranslateY);

    internal static ResolvedTransform ResolveTransform(ShapeDefinition shape, VariableStore store)
    {
        var definition = shape.RenderTransform;
        var rotate = definition?.Rotate;
        var scale = definition?.Scale;
        var translate = definition?.Translate;

        var centerX = rotate is not null ? Resolve(rotate.CenterX, store, 0) : 0;
        var centerY = rotate is not null ? Resolve(rotate.CenterY, store, 0) : 0;

        return new ResolvedTransform
        {
            Angle = rotate is not null ? Resolve(rotate.Value, store, 0) : 0,
            CenterX = centerX,
            CenterY = centerY,
            ScaleX = scale is not null ? Resolve(scale.ValueX, store, 1) : 1,
            ScaleY = scale is not null ? Resolve(scale.ValueY, store, 1) : 1,
            TranslateX = translate is not null ? Resolve(translate.X, store, 0) : 0,
            TranslateY = translate is not null ? Resolve(translate.Y, store, 0) : 0,
        };
    }

    /// <summary>Resolves a numeric property: constants pass through, bindings read the variable, missing values fall back to the default.</summary>
    internal static double Resolve(ValueRef? reference, VariableStore store, double fallback)
    {
        if (reference is null)
        {
            return fallback;
        }

        if (reference.IsBound)
        {
            return store.TryGet(reference.Variable!, out var value) ? value : fallback;
        }

        return reference.IsNumber ? reference.Number : fallback;
    }

    private static Color? ResolveColor(ValueRef? reference, VariableStore store)
    {
        if (reference is null)
        {
            return null;
        }

        if (reference.IsBound)
        {
            if (!store.TryGet(reference.Variable!, out var value))
            {
                return null;
            }

            return ColorParser.TryParseNumber(value, out var color) ? color : null;
        }

        if (!reference.TryGetText(out var text))
        {
            return null;
        }

        return ColorParser.TryParse(text, out var parsed) && parsed.A > 0 ? parsed : null;
    }

    private static PenLineCap ToPenCap(LineCapStyle style) => style switch
    {
        LineCapStyle.Round => PenLineCap.Round,
        LineCapStyle.Square => PenLineCap.Square,
        _ => PenLineCap.Flat,
    };

    private static PenLineJoin ToPenJoin(LineJoinStyle style) => style switch
    {
        LineJoinStyle.Round => PenLineJoin.Round,
        LineJoinStyle.Bevel => PenLineJoin.Bevel,
        _ => PenLineJoin.Miter,
    };

    private static uint ToKey(Color color) =>
        ((uint)color.A << 24) | ((uint)color.R << 16) | ((uint)color.G << 8) | color.B;
}
