using System.Windows;
using System.Windows.Input;
using VectAnim.Wpf.Serialization;

namespace VectAnim.Wpf.Controls;

/// <summary>Render mode.</summary>
public enum VectAnimRenderMode
{
    /// <summary>
    /// Draws directly through OnRender + DrawingContext (default, recommended).
    /// Creates no Shape objects, so it scales well when there are many shapes.
    /// </summary>
    Drawing,

    /// <summary>
    /// Generates Path visuals and adds them to the visual tree.
    /// Suited to scenarios needing native WPF hit testing/animation/effects; costlier with many shapes.
    /// </summary>
    Shapes,
}

/// <summary>Scale fit mode.</summary>
public enum VectAnimStretch
{
    /// <summary>Original size, aligned to the top-left.</summary>
    None,

    /// <summary>Uniform scaling, centered (default).</summary>
    Uniform,

    /// <summary>Uniform scaling to fill (may crop).</summary>
    UniformToFill,

    /// <summary>Non-uniform stretch to fill.</summary>
    Fill,
}

/// <summary>Event arguments for shape interaction.</summary>
public sealed class VectAnimShapeEventArgs : RoutedEventArgs
{
    internal VectAnimShapeEventArgs(RoutedEvent routedEvent, string shapeId, string shapeName, Point canvasPoint, Point controlPoint, MouseButton? button)
        : base(routedEvent)
    {
        ShapeId = shapeId;
        ShapeName = shapeName;
        CanvasPoint = canvasPoint;
        ControlPoint = controlPoint;
        Button = button;
    }

    /// <summary>Shape ID.</summary>
    public string ShapeId { get; }

    /// <summary>Shape name.</summary>
    public string ShapeName { get; }

    /// <summary>Canvas coordinates (unscaled, untranslated).</summary>
    public Point CanvasPoint { get; }

    /// <summary>Control coordinates.</summary>
    public Point ControlPoint { get; }

    /// <summary>Mouse button that triggered the event (null for hover events).</summary>
    public MouseButton? Button { get; }
}

/// <summary>Event arguments for load completion.</summary>
public sealed class VectAnimLoadEventArgs : EventArgs
{
    internal VectAnimLoadEventArgs(string? source, IReadOnlyList<ValidationIssue> issues)
    {
        Source = source;
        Issues = issues;
    }

    /// <summary>Source (file path or "&lt;string&gt;").</summary>
    public string? Source { get; }

    /// <summary>List of validation issues.</summary>
    public IReadOnlyList<ValidationIssue> Issues { get; }

    /// <summary>Whether any error-level issue exists.</summary>
    public bool HasErrors => Issues.Any(issue => issue.Severity == ValidationSeverity.Error);
}

/// <summary>Event arguments for a failed load.</summary>
public sealed class VectAnimLoadFailedEventArgs : EventArgs
{
    internal VectAnimLoadFailedEventArgs(string? source, Exception exception)
    {
        Source = source;
        Exception = exception;
    }

    /// <summary>Source.</summary>
    public string? Source { get; }

    /// <summary>The exception.</summary>
    public Exception Exception { get; }

    /// <summary>Error message.</summary>
    public string Message => Exception.Message;
}

/// <summary>Event arguments for a variable change.</summary>
public sealed class VectAnimVariableChangedEventArgs : EventArgs
{
    internal VectAnimVariableChangedEventArgs(string name, double value)
    {
        Name = name;
        Value = value;
    }

    /// <summary>Variable name.</summary>
    public string Name { get; }

    /// <summary>New value.</summary>
    public double Value { get; }
}

/// <summary>Event arguments for a runtime warning.</summary>
public sealed class VectAnimWarningEventArgs : EventArgs
{
    internal VectAnimWarningEventArgs(Runtime.RuntimeWarning warning) => Warning = warning;

    /// <summary>Warning content.</summary>
    public Runtime.RuntimeWarning Warning { get; }
}
