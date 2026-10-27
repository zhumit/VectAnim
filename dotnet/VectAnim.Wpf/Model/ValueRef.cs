using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using VectAnim.Wpf.Localization;

namespace VectAnim.Wpf.Model;

/// <summary>Property value kind.</summary>
public enum ValueKind
{
    /// <summary>Numeric constant.</summary>
    Number,

    /// <summary>Text constant (colors, etc.).</summary>
    Text,

    /// <summary>Variable binding.</summary>
    Binding,
}

/// <summary>
/// Property value union: <c>{ "Const": 100 }</c> or <c>{ "Bind": "VarName" }</c>.
/// Every animatable coordinate, size and color property of a shape uses this type.
/// </summary>
[JsonConverter(typeof(ValueRefJsonConverter))]
public sealed class ValueRef
{
    private ValueRef(ValueKind kind, double number, string? text, string? variable)
    {
        Kind = kind;
        Number = number;
        Text = text;
        Variable = variable;
    }

    /// <summary>Value kind.</summary>
    public ValueKind Kind { get; }

    /// <summary>Numeric value (only valid for <see cref="ValueKind.Number"/>).</summary>
    public double Number { get; }

    /// <summary>Text value (only valid for <see cref="ValueKind.Text"/>).</summary>
    public string? Text { get; }

    /// <summary>Variable name (only valid for <see cref="ValueKind.Binding"/>).</summary>
    public string? Variable { get; }

    /// <summary>Whether this is a variable binding.</summary>
    public bool IsBound => Kind == ValueKind.Binding;

    /// <summary>Whether this is a numeric constant.</summary>
    public bool IsNumber => Kind == ValueKind.Number;

    /// <summary>Whether this is a text constant.</summary>
    public bool IsText => Kind == ValueKind.Text;

    /// <summary>Creates a numeric constant.</summary>
    public static ValueRef FromNumber(double value) => new(ValueKind.Number, value, null, null);

    /// <summary>Creates a text constant.</summary>
    public static ValueRef FromText(string value) => new(ValueKind.Text, 0, value ?? string.Empty, null);

    /// <summary>Creates a variable binding.</summary>
    public static ValueRef Bind(string variableName)
    {
        if (string.IsNullOrWhiteSpace(variableName))
        {
            throw new ArgumentException(Strings.T("ValueRef.VariableNameEmpty"), nameof(variableName));
        }

        return new ValueRef(ValueKind.Binding, 0, null, variableName);
    }

    /// <summary>Tries to get the numeric value; returns false for bindings and non-numeric values.</summary>
    public bool TryGetNumber(out double value)
    {
        value = Number;
        return Kind == ValueKind.Number;
    }

    /// <summary>Tries to get the text value; numeric constants are converted using the invariant culture.</summary>
    public bool TryGetText(out string value)
    {
        switch (Kind)
        {
            case ValueKind.Text:
                value = Text ?? string.Empty;
                return true;
            case ValueKind.Number:
                value = Number.ToString(CultureInfo.InvariantCulture);
                return true;
            default:
                value = string.Empty;
                return false;
        }
    }

    /// <inheritdoc />
    public override string ToString() => Kind switch
    {
        ValueKind.Binding => $"⟨{Variable}⟩",
        ValueKind.Text => Text ?? string.Empty,
        _ => Number.ToString(CultureInfo.InvariantCulture),
    };
}

/// <summary>JSON reader/writer for ValueRef: accepts <c>{Const:number}</c>, <c>{Const:"text"}</c> and <c>{Bind:"name"}</c>.</summary>
public sealed class ValueRefJsonConverter : JsonConverter<ValueRef>
{
    /// <inheritdoc />
    public override bool HandleNull => true;

    /// <inheritdoc />
    public override ValueRef? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null)
        {
            return null;
        }

        // Tolerant form: a bare scalar is treated as a constant. Hand-written files use
        // `"Opacity": 0.5` instead of `{ "Const": 0.5 }`, and groups relied on that before
        // their opacity became bindable.
        if (reader.TokenType == JsonTokenType.Number)
        {
            return ValueRef.FromNumber(reader.GetDouble());
        }

        if (reader.TokenType == JsonTokenType.String)
        {
            return ValueRef.FromText(reader.GetString() ?? string.Empty);
        }

        if (reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException(Strings.T("ValueRef.MustBeConstOrBind"));
        }

        ValueRef? result = null;
        while (reader.Read())
        {
            if (reader.TokenType == JsonTokenType.EndObject)
            {
                break;
            }

            if (reader.TokenType != JsonTokenType.PropertyName)
            {
                throw new JsonException(Strings.T("ValueRef.InvalidStructure"));
            }

            var property = reader.GetString();
            reader.Read();

            if (string.Equals(property, "Bind", StringComparison.OrdinalIgnoreCase))
            {
                var name = reader.TokenType == JsonTokenType.Null ? null : reader.GetString();
                if (!string.IsNullOrWhiteSpace(name))
                {
                    result = ValueRef.Bind(name!);
                }
            }
            else if (string.Equals(property, "Const", StringComparison.OrdinalIgnoreCase))
            {
                switch (reader.TokenType)
                {
                    case JsonTokenType.Number:
                        result = ValueRef.FromNumber(reader.GetDouble());
                        break;
                    case JsonTokenType.String:
                        result = ValueRef.FromText(reader.GetString() ?? string.Empty);
                        break;
                    case JsonTokenType.True:
                        result = ValueRef.FromNumber(1);
                        break;
                    case JsonTokenType.False:
                        result = ValueRef.FromNumber(0);
                        break;
                    case JsonTokenType.Null:
                        // { "Const": null } means "no fill / no stroke"
                        result = null;
                        break;
                    default:
                        throw new JsonException(Strings.T("ValueRef.ConstUnsupportedType"));
                }
            }
            else
            {
                reader.Skip();
            }
        }

        return result;
    }

    /// <inheritdoc />
    public override void Write(Utf8JsonWriter writer, ValueRef value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        switch (value.Kind)
        {
            case ValueKind.Binding:
                writer.WriteString("Bind", value.Variable);
                break;
            case ValueKind.Text:
                writer.WriteString("Const", value.Text);
                break;
            default:
                writer.WriteNumber("Const", value.Number);
                break;
        }

        writer.WriteEndObject();
    }
}
