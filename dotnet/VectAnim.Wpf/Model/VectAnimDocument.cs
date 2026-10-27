using System.Text.Json;
using System.Text.Json.Serialization;

namespace VectAnim.Wpf.Model;

/// <summary>Shape type.</summary>
public enum ShapeKind
{
    /// <summary>Unknown type (fallback when parsing fails; removed during validation).</summary>
    Unknown = 0,

    /// <summary>Line.</summary>
    Line,

    /// <summary>Rectangle (may have rounded corners).</summary>
    Rectangle,

    /// <summary>Ellipse.</summary>
    Ellipse,

    /// <summary>Polygon / polyline.</summary>
    Polygon,

    /// <summary>Path (WPF Path Mini-Language).</summary>
    Path,
}

/// <summary>Line cap style.</summary>
public enum LineCapStyle
{
    /// <summary>Flat.</summary>
    Flat,

    /// <summary>Round.</summary>
    Round,

    /// <summary>Square.</summary>
    Square,
}

/// <summary>Line join style.</summary>
public enum LineJoinStyle
{
    /// <summary>Miter.</summary>
    Miter,

    /// <summary>Bevel.</summary>
    Bevel,

    /// <summary>Round.</summary>
    Round,
}

/// <summary>Easing kind.</summary>
public enum EasingKind
{
    /// <summary>Linear.</summary>
    Linear,

    /// <summary>Step (holds the start value until the next frame).</summary>
    Step,

    /// <summary>Ease in.</summary>
    EaseIn,

    /// <summary>Ease out.</summary>
    EaseOut,

    /// <summary>Ease in-out.</summary>
    EaseInOut,
}

/// <summary>Canvas definition.</summary>
public sealed class CanvasDefinition
{
    /// <summary>Canvas width (DIP).</summary>
    public double Width { get; set; } = 800;

    /// <summary>Canvas height (DIP).</summary>
    public double Height { get; set; } = 600;

    /// <summary>Background color (<c>#AARRGGBB</c> or a CSS color).</summary>
    public string Background { get; set; } = "#FFFFFFFF";
}

/// <summary>Variable definition.</summary>
public sealed class VariableDefinition
{
    /// <summary>Variable name (referenced by expressions and bindings).</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Default value.</summary>
    public double DefaultValue { get; set; }

    /// <summary>Description.</summary>
    public string? Description { get; set; }

    /// <summary>Lower bound of the value range.</summary>
    public double? Min { get; set; }

    /// <summary>Upper bound of the value range.</summary>
    public double? Max { get; set; }

    /// <summary>Unit.</summary>
    public string? Unit { get; set; }

    /// <summary>Decimal places (for host application display only).</summary>
    public int? Decimals { get; set; }
}

/// <summary>Rotation transform.</summary>
public sealed class RotateDefinition
{
    /// <summary>Rotation center X.</summary>
    public ValueRef? CenterX { get; set; }

    /// <summary>Rotation center Y.</summary>
    public ValueRef? CenterY { get; set; }

    /// <summary>Angle in degrees (clockwise is positive).</summary>
    public ValueRef? Value { get; set; }
}

/// <summary>Scale transform (extension field).</summary>
public sealed class ScaleDefinition
{
    /// <summary>Scale center X.</summary>
    public ValueRef? CenterX { get; set; }

    /// <summary>Scale center Y.</summary>
    public ValueRef? CenterY { get; set; }

    /// <summary>Scale factor along X.</summary>
    public ValueRef? ValueX { get; set; }

    /// <summary>Scale factor along Y.</summary>
    public ValueRef? ValueY { get; set; }
}

/// <summary>Translate transform (extension field).</summary>
public sealed class TranslateDefinition
{
    /// <summary>Translation along X.</summary>
    public ValueRef? X { get; set; }

    /// <summary>Translation along Y.</summary>
    public ValueRef? Y { get; set; }
}

/// <summary>Render transform set: scale first, then rotate, then translate.</summary>
public sealed class RenderTransformDefinition
{
    /// <summary>Rotation.</summary>
    public RotateDefinition? Rotate { get; set; }

    /// <summary>Scale.</summary>
    public ScaleDefinition? Scale { get; set; }

    /// <summary>Translation.</summary>
    public TranslateDefinition? Translate { get; set; }
}

/// <summary>Polygon vertex.</summary>
public sealed class PointRef
{
    /// <summary>X coordinate.</summary>
    public ValueRef? X { get; set; }

    /// <summary>Y coordinate.</summary>
    public ValueRef? Y { get; set; }
}

/// <summary>
/// Shape definition. Uses a "flat structure + Type discriminator" to keep JSON parsing and error tolerance simple:
/// Unused fields are null; the runtime picks fields according to Type.
/// </summary>
public sealed class ShapeDefinition
{
    /// <summary>Unique identifier.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>Display name.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Shape type.</summary>
    [JsonConverter(typeof(TolerantEnumConverter<ShapeKind>))]
    public ShapeKind Type { get; set; }

    /// <summary>Whether the shape is visible.</summary>
    public bool IsVisible { get; set; } = true;

    /// <summary>Z-order; larger values are drawn on top.</summary>
    public double ZIndex { get; set; }

    /// <summary>Opacity, 0..1.</summary>
    public ValueRef? Opacity { get; set; }

    /// <summary>Fill color; null means no fill.</summary>
    public ValueRef? Fill { get; set; }

    /// <summary>Stroke color; null means no stroke.</summary>
    public ValueRef? Stroke { get; set; }

    /// <summary>Stroke thickness.</summary>
    public ValueRef? StrokeThickness { get; set; }

    /// <summary>Line cap style.</summary>
    [JsonConverter(typeof(TolerantEnumConverter<LineCapStyle>))]
    public LineCapStyle? LineCap { get; set; }

    /// <summary>Line join style.</summary>
    [JsonConverter(typeof(TolerantEnumConverter<LineJoinStyle>))]
    public LineJoinStyle? LineJoin { get; set; }

    /// <summary>Transform.</summary>
    public RenderTransformDefinition? RenderTransform { get; set; }

    /// <summary>Line start X.</summary>
    public ValueRef? X1 { get; set; }

    /// <summary>Line start Y.</summary>
    public ValueRef? Y1 { get; set; }

    /// <summary>Line end X.</summary>
    public ValueRef? X2 { get; set; }

    /// <summary>Line end Y.</summary>
    public ValueRef? Y2 { get; set; }

    /// <summary>Rectangle top-left X.</summary>
    public ValueRef? X { get; set; }

    /// <summary>Rectangle top-left Y.</summary>
    public ValueRef? Y { get; set; }

    /// <summary>Rectangle width.</summary>
    public ValueRef? Width { get; set; }

    /// <summary>Rectangle height.</summary>
    public ValueRef? Height { get; set; }

    /// <summary>Rectangle corner radius X.</summary>
    public ValueRef? RadiusX { get; set; }

    /// <summary>Rectangle corner radius Y.</summary>
    public ValueRef? RadiusY { get; set; }

    /// <summary>Ellipse center X.</summary>
    public ValueRef? CenterX { get; set; }

    /// <summary>Ellipse center Y.</summary>
    public ValueRef? CenterY { get; set; }

    /// <summary>Polygon vertices.</summary>
    public List<PointRef>? Points { get; set; }

    /// <summary>Whether the polygon is closed.</summary>
    public bool? IsClosed { get; set; }

    /// <summary>Path data (WPF mini-language).</summary>
    public string? Data { get; set; }

    /// <summary>Path offset X.</summary>
    public double? OffsetX { get; set; }

    /// <summary>Path offset Y.</summary>
    public double? OffsetY { get; set; }

    /// <summary>Names of all variables bound by this shape (populated at runtime for diagnostics).</summary>
    [JsonIgnore]
    public IReadOnlyList<string> BoundVariables { get; internal set; } = Array.Empty<string>();
}

/// <summary>Group definition.</summary>
public sealed class ShapeGroup
{
    /// <summary>Group identifier.</summary>
    public string GroupId { get; set; } = string.Empty;

    /// <summary>Group name.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Ids of the member shapes.</summary>
    public List<string> ShapeIds { get; set; } = new();

    /// <summary>Whether the group is visible (ANDed with member visibility).</summary>
    public bool Visible { get; set; } = true;

    /// <summary>
    /// Group opacity 0..1 (extension field). A bare number in the JSON is accepted as a constant,
    /// so files written before group opacity became bindable keep loading.
    /// </summary>
    public ValueRef? Opacity { get; set; }

    /// <summary>
    /// Transform applied to the whole group, on top of every member's own transform
    /// (extension field; absent means the identity transform).
    /// </summary>
    public RenderTransformDefinition? RenderTransform { get; set; }

    /// <summary>Whether the group is locked (editor semantics; ignored at runtime).</summary>
    public bool? Locked { get; set; }
}

/// <summary>Expression animation.</summary>
public sealed class ExpressionAnimationDefinition
{
    /// <summary>Identifier.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>Name of the driven variable.</summary>
    public string TargetVariable { get; set; } = string.Empty;

    /// <summary>Expression.</summary>
    public string Expression { get; set; } = string.Empty;

    /// <summary>Whether enabled.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Result modulus (for example 360 to wrap angles).</summary>
    public double? Wrap { get; set; }
}

/// <summary>Keyframe.</summary>
public sealed class Keyframe
{
    /// <summary>Time in seconds.</summary>
    public double Time { get; set; }

    /// <summary>Value.</summary>
    public double Value { get; set; }

    /// <summary>Easing to the next keyframe.</summary>
    [JsonConverter(typeof(TolerantEnumConverter<EasingKind>))]
    public EasingKind? Easing { get; set; }
}

/// <summary>Keyframe animation.</summary>
public sealed class KeyframeAnimationDefinition
{
    /// <summary>Identifier.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>Name.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Name of the driven variable.</summary>
    public string TargetVariable { get; set; } = string.Empty;

    /// <summary>Whether to loop.</summary>
    public bool Loop { get; set; }

    /// <summary>Keyframe collection.</summary>
    public List<Keyframe> Keyframes { get; set; } = new();

    /// <summary>Whether enabled (defaults to true).</summary>
    public bool? Enabled { get; set; }

    /// <summary>Pause in seconds between loops.</summary>
    public double? LoopDelay { get; set; }
}

/// <summary>Document metadata.</summary>
public sealed class DocumentMeta
{
    /// <summary>Title.</summary>
    public string? Title { get; set; }

    /// <summary>Description.</summary>
    public string? Description { get; set; }

    /// <summary>Author.</summary>
    public string? Author { get; set; }

    /// <summary>Creation time.</summary>
    public string? CreatedAt { get; set; }

    /// <summary>Update time.</summary>
    public string? UpdatedAt { get; set; }
}

/// <summary>VectAnim document (root object of .vectanim.json).</summary>
public sealed class VectAnimDocument
{
    /// <summary>Schema version.</summary>
    public string SchemaVersion { get; set; } = "1.0";

    /// <summary>Canvas.</summary>
    public CanvasDefinition Canvas { get; set; } = new();

    /// <summary>Variable table.</summary>
    public List<VariableDefinition> Variables { get; set; } = new();

    /// <summary>Shape collection.</summary>
    public List<ShapeDefinition> Shapes { get; set; } = new();

    /// <summary>Expression animations.</summary>
    public List<ExpressionAnimationDefinition> ExpressionAnimations { get; set; } = new();

    /// <summary>Keyframe animations.</summary>
    public List<KeyframeAnimationDefinition> KeyframeAnimations { get; set; } = new();

    /// <summary>Groups.</summary>
    public List<ShapeGroup> Groups { get; set; } = new();

    /// <summary>Metadata.</summary>
    public DocumentMeta? Meta { get; set; }
}

/// <summary>
/// Tolerant string enum converter: unknown values fall back to the default value instead of throwing,
/// so files hand-edited in the field can still be loaded.
/// </summary>
public sealed class TolerantEnumConverter<T> : JsonConverter<T>
    where T : struct, Enum
{
    /// <inheritdoc />
    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String)
        {
            var text = reader.GetString();
            if (!string.IsNullOrWhiteSpace(text) && Enum.TryParse<T>(text, ignoreCase: true, out var parsed))
            {
                return parsed;
            }

            return default;
        }

        if (reader.TokenType == JsonTokenType.Number && reader.TryGetInt32(out var numeric))
        {
            return (T)Enum.ToObject(typeof(T), numeric);
        }

        reader.Skip();
        return default;
    }

    /// <inheritdoc />
    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options)
    {
        writer.WriteStringValue(value.ToString());
    }
}
