using System.Windows;
using System.Windows.Media;

namespace VectAnim.Wpf.Rendering;

/// <summary>
/// Pen/brush cache.
///
/// Industrial screens usually have dozens of shapes but only a few colors; creating a new Brush/Pen each frame
/// would cost many managed heap allocations and WPF property system overhead. Brushes and pens are cached by
/// color/line width and frozen here, leaving only the drawing commands per frame.
/// </summary>
public sealed class BrushCache
{
    private readonly Dictionary<uint, SolidColorBrush> _brushes = new();
    private readonly Dictionary<PenKey, Pen> _pens = new();

    /// <summary>Gets a frozen solid-color brush.</summary>
    public SolidColorBrush GetBrush(Color color)
    {
        var key = ToKey(color);
        if (_brushes.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var brush = new SolidColorBrush(color);
        brush.Freeze();
        _brushes[key] = brush;
        return brush;
    }

    /// <summary>Gets a frozen pen.</summary>
    public Pen GetPen(Color color, double thickness, PenLineCap cap, PenLineJoin join)
    {
        var key = new PenKey(ToKey(color), Math.Round(thickness, 3), cap, join);
        if (_pens.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var pen = new Pen(GetBrush(color), key.Thickness)
        {
            StartLineCap = cap,
            EndLineCap = cap,
            DashCap = cap,
            LineJoin = join,
            MiterLimit = 4,
        };
        pen.Freeze();
        _pens[key] = pen;
        return pen;
    }

    /// <summary>Clears the cache (called when switching document or theme).</summary>
    public void Clear()
    {
        _brushes.Clear();
        _pens.Clear();
    }

    private static uint ToKey(Color color) =>
        ((uint)color.A << 24) | ((uint)color.R << 16) | ((uint)color.G << 8) | color.B;

    private readonly record struct PenKey(uint Color, double Thickness, PenLineCap Cap, PenLineJoin Join);
}

/// <summary>Resolved transform (mirrors the editor's ResolvedTransform one to one).</summary>
public struct ResolvedTransform
{
    /// <summary>Angle (degrees, clockwise).</summary>
    public double Angle;

    /// <summary>Rotation/scale center X.</summary>
    public double CenterX;

    /// <summary>Rotation/scale center Y.</summary>
    public double CenterY;

    /// <summary>X scale.</summary>
    public double ScaleX;

    /// <summary>Y scale.</summary>
    public double ScaleY;

    /// <summary>X translation.</summary>
    public double TranslateX;

    /// <summary>Y translation.</summary>
    public double TranslateY;

    /// <summary>Whether this is the identity transform.</summary>
    public readonly bool IsIdentity =>
        Angle == 0 && ScaleX == 1 && ScaleY == 1 && TranslateX == 0 && TranslateY == 0;

    /// <summary>Converts to a matrix: scale first, then rotate, then translate.</summary>
    public readonly Matrix ToMatrix()
    {
        // WPF Matrix methods append: earlier calls take effect first.
        // Target semantics are p' = Translate(Rotate(Scale(p))), so the call order is scale -> rotate -> translate.
        var matrix = Matrix.Identity;
        if (ScaleX != 1 || ScaleY != 1)
        {
            matrix.ScaleAt(ScaleX, ScaleY, CenterX, CenterY);
        }

        if (Angle != 0)
        {
            matrix.RotateAt(Angle, CenterX, CenterY);
        }

        if (TranslateX != 0 || TranslateY != 0)
        {
            matrix.Translate(TranslateX, TranslateY);
        }

        return matrix;
    }
}
