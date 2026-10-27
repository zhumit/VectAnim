using System.Globalization;
using System.Windows.Media;
using VectAnim.Wpf.Localization;
using VectAnim.Wpf.Model;

namespace VectAnim.Wpf.Serialization;

/// <summary>Validation severity.</summary>
public enum ValidationSeverity
{
    /// <summary>Informational.</summary>
    Info,

    /// <summary>Warning: automatically corrected; execution can continue.</summary>
    Warning,

    /// <summary>Error: the node is skipped or falls back to a default value.</summary>
    Error,
}

/// <summary>A validation issue.</summary>
public sealed class ValidationIssue
{
    internal ValidationIssue(string path, string message, ValidationSeverity severity)
    {
        Path = path;
        Message = message;
        Severity = severity;
    }

    /// <summary>Field path, e.g. <c>Shapes[3].Width</c>.</summary>
    public string Path { get; }

    /// <summary>Description.</summary>
    public string Message { get; }

    /// <summary>Severity.</summary>
    public ValidationSeverity Severity { get; }

    /// <inheritdoc />
    public override string ToString() => $"[{Severity}] {Path}: {Message}";
}

/// <summary>
/// Document validation and normalization.
///
/// Normalization repairs fixable problems in place (fills in defaults, de-duplicates Ids, sorts keyframes, drops invalid shapes),
/// and records every repair as a <see cref="ValidationIssue"/> so the host application can keep an audit trail in its logs.
/// </summary>
public static class DocumentValidator
{
    /// <summary>Validates and normalizes the document.</summary>
    public static IReadOnlyList<ValidationIssue> Normalize(VectAnimDocument document)
    {
        var issues = new List<ValidationIssue>();
        if (document is null)
        {
            issues.Add(new ValidationIssue("$", Strings.T("Validation.DocumentNull"), ValidationSeverity.Error));
            return issues;
        }

        document.Canvas ??= new CanvasDefinition();
        document.Variables ??= new List<VariableDefinition>();
        document.Shapes ??= new List<ShapeDefinition>();
        document.ExpressionAnimations ??= new List<ExpressionAnimationDefinition>();
        document.KeyframeAnimations ??= new List<KeyframeAnimationDefinition>();
        document.Groups ??= new List<ShapeGroup>();

        if (string.IsNullOrWhiteSpace(document.SchemaVersion))
        {
            document.SchemaVersion = "1.0";
            issues.Add(new ValidationIssue("SchemaVersion", Strings.T("Validation.SchemaVersionMissing"), ValidationSeverity.Info));
        }
        else if (!document.SchemaVersion.StartsWith("1.", StringComparison.Ordinal))
        {
            issues.Add(new ValidationIssue(
                "SchemaVersion",
                Strings.T("Validation.SchemaVersionMismatch", document.SchemaVersion),
                ValidationSeverity.Warning));
        }

        if (!(document.Canvas.Width > 0) || !(document.Canvas.Height > 0))
        {
            issues.Add(new ValidationIssue(
                "Canvas",
                Strings.T("Validation.CanvasSizeInvalid", document.Canvas.Width, document.Canvas.Height),
                ValidationSeverity.Error));
            document.Canvas.Width = 800;
            document.Canvas.Height = 600;
        }

        if (string.IsNullOrWhiteSpace(document.Canvas.Background) || !TryParseColor(document.Canvas.Background, out _))
        {
            issues.Add(new ValidationIssue("Canvas.Background", Strings.T("Validation.CanvasBackgroundInvalid"), ValidationSeverity.Warning));
            document.Canvas.Background = "#FFFFFFFF";
        }

        NormalizeVariables(document, issues);
        NormalizeShapes(document, issues);
        NormalizeGroups(document, issues);
        NormalizeExpressionAnimations(document, issues);
        NormalizeKeyframeAnimations(document, issues);

        return issues;
    }

    private static void NormalizeVariables(VectAnimDocument document, List<ValidationIssue> issues)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var kept = new List<VariableDefinition>(document.Variables.Count);

        for (var index = 0; index < document.Variables.Count; index++)
        {
            var variable = document.Variables[index];
            var path = $"Variables[{index}]";

            if (variable is null || string.IsNullOrWhiteSpace(variable.Name))
            {
                issues.Add(new ValidationIssue(path, Strings.T("Validation.VariableNameEmpty"), ValidationSeverity.Error));
                continue;
            }

            if (!seen.Add(variable.Name))
            {
                issues.Add(new ValidationIssue(path, Strings.T("Validation.VariableDuplicate", variable.Name), ValidationSeverity.Error));
                continue;
            }

            if (double.IsNaN(variable.DefaultValue) || double.IsInfinity(variable.DefaultValue))
            {
                issues.Add(new ValidationIssue(path, Strings.T("Validation.VariableDefaultNotFinite"), ValidationSeverity.Warning));
                variable.DefaultValue = 0;
            }

            if (variable.Min.HasValue && variable.Max.HasValue && variable.Min > variable.Max)
            {
                issues.Add(new ValidationIssue(path, Strings.T("Validation.VariableMinGreaterThanMax"), ValidationSeverity.Warning));
                (variable.Min, variable.Max) = (variable.Max, variable.Min);
            }

            kept.Add(variable);
        }

        document.Variables = kept;
    }

    private static void NormalizeShapes(VectAnimDocument document, List<ValidationIssue> issues)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var kept = new List<ShapeDefinition>(document.Shapes.Count);

        for (var index = 0; index < document.Shapes.Count; index++)
        {
            var shape = document.Shapes[index];
            var path = $"Shapes[{index}]";

            if (shape is null)
            {
                issues.Add(new ValidationIssue(path, Strings.T("Validation.ShapeNull"), ValidationSeverity.Error));
                continue;
            }

            if (string.IsNullOrWhiteSpace(shape.Id))
            {
                shape.Id = $"shape_{index + 1}";
                issues.Add(new ValidationIssue(path, Strings.T("Validation.ShapeIdMissing", shape.Id), ValidationSeverity.Warning));
            }

            if (!seen.Add(shape.Id))
            {
                var unique = $"{shape.Id}_{index + 1}";
                issues.Add(new ValidationIssue(path, Strings.T("Validation.ShapeIdDuplicate", shape.Id, unique), ValidationSeverity.Warning));
                shape.Id = unique;
                seen.Add(unique);
            }

            if (shape.Type == ShapeKind.Unknown)
            {
                issues.Add(new ValidationIssue(path, Strings.T("Validation.ShapeTypeUnsupported", shape.Id), ValidationSeverity.Error));
                continue;
            }

            if (string.IsNullOrWhiteSpace(shape.Name))
            {
                shape.Name = shape.Id;
            }

            if (double.IsNaN(shape.ZIndex) || double.IsInfinity(shape.ZIndex))
            {
                shape.ZIndex = index * 10;
            }

            if (shape.Type == ShapeKind.Path)
            {
                if (!PathDataValidator.TryValidate(shape.Data, out var pathError))
                {
                    issues.Add(new ValidationIssue(path, Strings.T("Validation.PathDataInvalid", pathError!), ValidationSeverity.Error));
                    shape.Data = string.Empty;
                    continue;
                }

                try
                {
                    _ = Geometry.Parse(shape.Data);
                }
                catch (Exception exception)
                {
                    issues.Add(new ValidationIssue(path, Strings.T("Validation.PathDataUnparsable", exception.Message), ValidationSeverity.Error));
                    shape.Data = string.Empty;
                    continue;
                }
            }

            if (shape.Type == ShapeKind.Polygon && (shape.Points is null || shape.Points.Count < 2))
            {
                issues.Add(new ValidationIssue(path, Strings.T("Validation.PolygonTooFewPoints"), ValidationSeverity.Error));
                continue;
            }

            if (shape.Type == ShapeKind.Polygon && shape.IsClosed is null)
            {
                shape.IsClosed = true;
            }

            CheckColor(shape.Fill, $"{path}.Fill", issues);
            CheckColor(shape.Stroke, $"{path}.Stroke", issues);

            kept.Add(shape);
        }

        document.Shapes = kept;
    }

    private static void NormalizeGroups(VectAnimDocument document, List<ValidationIssue> issues)
    {
        var shapeIds = new HashSet<string>(document.Shapes.Select(shape => shape.Id), StringComparer.Ordinal);
        var assigned = new HashSet<string>(StringComparer.Ordinal);
        var seenGroups = new HashSet<string>(StringComparer.Ordinal);
        var kept = new List<ShapeGroup>(document.Groups.Count);

        for (var index = 0; index < document.Groups.Count; index++)
        {
            var group = document.Groups[index];
            var path = $"Groups[{index}]";

            if (group is null)
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(group.GroupId))
            {
                group.GroupId = $"group_{index + 1}";
            }

            if (!seenGroups.Add(group.GroupId))
            {
                var unique = $"{group.GroupId}_{index + 1}";
                issues.Add(new ValidationIssue(path, Strings.T("Validation.GroupIdDuplicate", unique), ValidationSeverity.Warning));
                group.GroupId = unique;
                seenGroups.Add(unique);
            }

            if (string.IsNullOrWhiteSpace(group.Name))
            {
                group.Name = group.GroupId;
            }

            if (group.Opacity is { IsNumber: true } && (group.Opacity.Number < 0 || group.Opacity.Number > 1))
            {
                group.Opacity = ValueRef.FromNumber(Math.Clamp(group.Opacity.Number, 0, 1));
            }

            var members = new List<string>(group.ShapeIds.Count);
            foreach (var id in group.ShapeIds)
            {
                if (string.IsNullOrWhiteSpace(id))
                {
                    continue;
                }

                if (!shapeIds.Contains(id))
                {
                    issues.Add(new ValidationIssue(path, Strings.T("Validation.GroupShapeMissing", id), ValidationSeverity.Warning));
                    continue;
                }

                if (!assigned.Add(id))
                {
                    issues.Add(new ValidationIssue(path, Strings.T("Validation.GroupShapeAlreadyAssigned", id), ValidationSeverity.Warning));
                    continue;
                }

                members.Add(id);
            }

            group.ShapeIds = members;
            if (members.Count > 0)
            {
                kept.Add(group);
            }
        }

        document.Groups = kept;
    }

    private static void NormalizeExpressionAnimations(VectAnimDocument document, List<ValidationIssue> issues)
    {
        var kept = new List<ExpressionAnimationDefinition>(document.ExpressionAnimations.Count);

        for (var index = 0; index < document.ExpressionAnimations.Count; index++)
        {
            var animation = document.ExpressionAnimations[index];
            var path = $"ExpressionAnimations[{index}]";

            if (animation is null)
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(animation.Id))
            {
                animation.Id = $"expr_{index + 1}";
            }

            if (string.IsNullOrWhiteSpace(animation.TargetVariable))
            {
                issues.Add(new ValidationIssue(path, Strings.T("Validation.ExpressionTargetMissing"), ValidationSeverity.Error));
                continue;
            }

            if (string.IsNullOrWhiteSpace(animation.Expression))
            {
                issues.Add(new ValidationIssue(path, Strings.T("Validation.ExpressionEmpty"), ValidationSeverity.Error));
                continue;
            }

            if (!Expressions.ExpressionCompiler.TryCompile(animation.Expression, out _, out var error))
            {
                issues.Add(new ValidationIssue(path, Strings.T("Validation.ExpressionSyntaxError", error!), ValidationSeverity.Error));
                continue;
            }

            kept.Add(animation);
        }

        document.ExpressionAnimations = kept;
    }

    private static void NormalizeKeyframeAnimations(VectAnimDocument document, List<ValidationIssue> issues)
    {
        var kept = new List<KeyframeAnimationDefinition>(document.KeyframeAnimations.Count);

        for (var index = 0; index < document.KeyframeAnimations.Count; index++)
        {
            var animation = document.KeyframeAnimations[index];
            var path = $"KeyframeAnimations[{index}]";

            if (animation is null)
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(animation.Id))
            {
                animation.Id = $"kf_{index + 1}";
            }

            if (string.IsNullOrWhiteSpace(animation.Name))
            {
                animation.Name = animation.Id;
            }

            if (string.IsNullOrWhiteSpace(animation.TargetVariable))
            {
                issues.Add(new ValidationIssue(path, Strings.T("Validation.KeyframeTargetMissing"), ValidationSeverity.Error));
                continue;
            }

            var frames = new List<Keyframe>();
            foreach (var frame in animation.Keyframes)
            {
                if (frame is null)
                {
                    continue;
                }

                if (double.IsNaN(frame.Time) || double.IsNaN(frame.Value))
                {
                    issues.Add(new ValidationIssue(path, Strings.T("Validation.KeyframeInvalid"), ValidationSeverity.Warning));
                    continue;
                }

                frames.Add(new Keyframe
                {
                    Time = Math.Max(0, frame.Time),
                    Value = frame.Value,
                    Easing = frame.Easing,
                });
            }

            if (frames.Count == 0)
            {
                issues.Add(new ValidationIssue(path, Strings.T("Validation.KeyframeEmpty"), ValidationSeverity.Warning));
                continue;
            }

            animation.Keyframes = Animation.KeyframeSampler.Sort(frames);
            if (animation.LoopDelay is < 0)
            {
                animation.LoopDelay = 0;
            }

            kept.Add(animation);
        }

        document.KeyframeAnimations = kept;
    }

    private static void CheckColor(ValueRef? reference, string path, List<ValidationIssue> issues)
    {
        if (reference is null || reference.IsBound)
        {
            return;
        }

        if (reference.TryGetText(out var text) && !TryParseColor(text, out _))
        {
            issues.Add(new ValidationIssue(path, Strings.T("Validation.ColorUnrecognized", text), ValidationSeverity.Warning));
        }
    }

    /// <summary>Color parsing (shared by validation and rendering).</summary>
    public static bool TryParseColor(string? text, out Color color) => Rendering.ColorParser.TryParse(text, out color);

    /// <summary>Formats a color value as a string suitable for log output.</summary>
    internal static string Describe(ValueRef? reference) => reference?.ToString() ?? "null";

    internal static string Invariant(double value) => value.ToString("0.###", CultureInfo.InvariantCulture);
}
