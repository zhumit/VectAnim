using System.Globalization;
using System.Windows.Media;

namespace VectAnim.Wpf.Rendering;

/// <summary>
/// Color parsing.
///
/// Conventions (matching the editor):
///  - <c>#AARRGGBB</c>: 8-digit hex, alpha first, per the WPF convention;
///  - <c>#RRGGBB</c> / <c>#RGB</c>: opaque;
///  - <c>rgba(r,g,b,a)</c> / <c>rgb(...)</c> / <c>hsl(...)</c>: CSS syntax;
///  - Named colors (Red, SteelBlue, ...);
///  - Plain numeric string or number: interpreted as a <c>0xRRGGBB</c> integer (common for color bindings).
/// </summary>
public static class ColorParser
{
    /// <summary>Parses a color string.</summary>
    public static bool TryParse(string? text, out Color color)
    {
        color = Colors.Transparent;
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var value = text.Trim();

        if (value.StartsWith('#'))
        {
            return TryParseHex(value.Substring(1), out color);
        }

        if (value.StartsWith("rgb", StringComparison.OrdinalIgnoreCase))
        {
            return TryParseRgbFunction(value, out color);
        }

        if (value.StartsWith("hsl", StringComparison.OrdinalIgnoreCase))
        {
            return TryParseHslFunction(value, out color);
        }

        if (double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var numeric))
        {
            return TryParseNumber(numeric, out color);
        }

        if (string.Equals(value, "transparent", StringComparison.OrdinalIgnoreCase))
        {
            color = Colors.Transparent;
            return true;
        }

        try
        {
            var converted = ColorConverter.ConvertFromString(value);
            if (converted is Color parsed)
            {
                color = parsed;
                return true;
            }
        }
        catch
        {
            // Fall through to the false return below.
        }

        return false;
    }

    /// <summary>Numeric color: 0xRRGGBB.</summary>
    public static bool TryParseNumber(double value, out Color color)
    {
        color = Colors.Transparent;
        if (double.IsNaN(value) || double.IsInfinity(value) || value < 0)
        {
            return false;
        }

        var integer = (uint)Math.Round(value) & 0xFFFFFF;
        color = Color.FromRgb((byte)((integer >> 16) & 0xFF), (byte)((integer >> 8) & 0xFF), (byte)(integer & 0xFF));
        return true;
    }

    private static bool TryParseHex(string hex, out Color color)
    {
        color = Colors.Transparent;
        var text = hex.Trim();
        if (text.Length == 3)
        {
            text = string.Concat(text.Select(character => new string(character, 2)));
        }
        else if (text.Length == 4)
        {
            text = string.Concat(text.Select(character => new string(character, 2)));
        }

        if (text.Length is not (6 or 8))
        {
            return false;
        }

        if (!uint.TryParse(text, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var value))
        {
            return false;
        }

        if (text.Length == 6)
        {
            color = Color.FromRgb((byte)((value >> 16) & 0xFF), (byte)((value >> 8) & 0xFF), (byte)(value & 0xFF));
            return true;
        }

        // 8 digits: WPF convention #AARRGGBB
        color = Color.FromArgb((byte)((value >> 24) & 0xFF), (byte)((value >> 16) & 0xFF), (byte)((value >> 8) & 0xFF), (byte)(value & 0xFF));
        return true;
    }

    private static bool TryParseRgbFunction(string text, out Color color)
    {
        color = Colors.Transparent;
        var open = text.IndexOf('(');
        var close = text.LastIndexOf(')');
        if (open < 0 || close <= open)
        {
            return false;
        }

        var parts = text.Substring(open + 1, close - open - 1)
            .Split(new[] { ',', '/', ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 3)
        {
            return false;
        }

        byte Channel(string raw)
        {
            var trimmed = raw.Trim();
            var value = trimmed.EndsWith('%')
                ? ParseDouble(trimmed[..^1]) / 100 * 255
                : ParseDouble(trimmed);
            return (byte)Math.Clamp(Math.Round(value), 0, 255);
        }

        byte alpha = 255;
        if (parts.Length >= 4)
        {
            var raw = parts[3].Trim();
            var value = raw.EndsWith('%') ? ParseDouble(raw[..^1]) / 100 : ParseDouble(raw);
            alpha = (byte)Math.Clamp(Math.Round(value * 255), 0, 255);
        }

        color = Color.FromArgb(alpha, Channel(parts[0]), Channel(parts[1]), Channel(parts[2]));
        return true;
    }

    private static bool TryParseHslFunction(string text, out Color color)
    {
        color = Colors.Transparent;
        var open = text.IndexOf('(');
        var close = text.LastIndexOf(')');
        if (open < 0 || close <= open)
        {
            return false;
        }

        var parts = text.Substring(open + 1, close - open - 1)
            .Split(new[] { ',', '/', ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 3)
        {
            return false;
        }

        var hue = ((ParseDouble(parts[0].Trim().TrimEnd('%')) % 360) + 360) % 360;
        var saturation = Math.Clamp(ParseDouble(parts[1].Trim().TrimEnd('%')) / 100, 0, 1);
        var lightness = Math.Clamp(ParseDouble(parts[2].Trim().TrimEnd('%')) / 100, 0, 1);

        var alpha = 1d;
        if (parts.Length >= 4)
        {
            var raw = parts[3].Trim();
            alpha = Math.Clamp(raw.EndsWith('%') ? ParseDouble(raw[..^1]) / 100 : ParseDouble(raw), 0, 1);
        }

        var chroma = (1 - Math.Abs((2 * lightness) - 1)) * saturation;
        var hp = hue / 60;
        var second = chroma * (1 - Math.Abs((hp % 2) - 1));
        double r, g, b;
        switch (hp)
        {
            case < 1: r = chroma; g = second; b = 0; break;
            case < 2: r = second; g = chroma; b = 0; break;
            case < 3: r = 0; g = chroma; b = second; break;
            case < 4: r = 0; g = second; b = chroma; break;
            case < 5: r = second; g = 0; b = chroma; break;
            default: r = chroma; g = 0; b = second; break;
        }

        var m = lightness - (chroma / 2);
        color = Color.FromArgb(
            (byte)Math.Clamp(Math.Round(alpha * 255), 0, 255),
            (byte)Math.Clamp(Math.Round((r + m) * 255), 0, 255),
            (byte)Math.Clamp(Math.Round((g + m) * 255), 0, 255),
            (byte)Math.Clamp(Math.Round((b + m) * 255), 0, 255));
        return true;
    }

    private static double ParseDouble(string text) =>
        double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : 0;
}
